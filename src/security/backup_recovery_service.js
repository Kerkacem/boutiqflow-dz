/**
 * BoutiqFlow DZ — Backup, Checksum Verification, PITR & Disaster Recovery Engine (INV-13-11 to INV-13-16, INV-13-27, INV-13-28)
 * Manages encrypted backup snapshots, cryptographic checksum validation,
 * corruption detection, Point-In-Time-Recovery (PITR), and disaster recovery restoration.
 */

const crypto = require('crypto');
const { KEY_TYPES, SECURITY_ERRORS } = require('./constants');
const { defaultKeyManager } = require('./key_management_service');

function jsonReplacer(key, value) {
  if (typeof value === 'bigint') {
    return { __bigint: value.toString() };
  }
  return value;
}

function jsonReviver(key, value) {
  if (value && typeof value === 'object' && value.__bigint !== undefined) {
    return BigInt(value.__bigint);
  }
  return value;
}

class BackupRecoveryService {
  /**
   * Creates an encrypted backup snapshot with SHA-256 integrity checksum (INV-13-11)
   */
  static createBackup(db, {
    backupType = 'FULL',
    keyManager = defaultKeyManager,
    marker = null
  } = {}) {
    // 1. Snapshot all tables data
    const snapshotData = {};
    for (const [tableName, map] of Object.entries(db.tables)) {
      snapshotData[tableName] = Array.from(map.entries()).map(([k, v]) => [k, { ...v }]);
    }

    const rawJson = JSON.stringify({
      version: '1.0',
      timestamp: new Date().toISOString(),
      marker,
      tables: snapshotData
    }, jsonReplacer);

    // 2. Compute SHA-256 Checksum before encryption
    const sha256Checksum = crypto.createHash('sha256').update(rawJson).digest('hex');

    // 3. Encrypt snapshot using dedicated BACKUP_ENCRYPTION key
    const encryptedPayload = keyManager.encrypt(rawJson, KEY_TYPES.BACKUP_ENCRYPTION);

    const backupId = `BKP-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const archive = {
      id: backupId,
      backupType,
      checksum: sha256Checksum,
      encryptedPayload,
      marker,
      createdAt: new Date().toISOString()
    };

    return archive;
  }

  /**
   * Verifies backup integrity without modifying target environment (Requirement 37)
   */
  static verifyBackupArchive(archive, { keyManager = defaultKeyManager } = {}) {
    if (!archive || !archive.encryptedPayload || !archive.checksum) {
      const err = new Error('Corrupt backup manifest: missing required payload or checksum (INV-13-11)');
      err.code = SECURITY_ERRORS.CORRUPT_BACKUP_DETECTED;
      throw err;
    }

    let decryptedJson;
    try {
      decryptedJson = keyManager.decrypt(archive.encryptedPayload);
    } catch (e) {
      const err = new Error(`Backup decryption failed or key mismatch: ${e.message}`);
      err.code = SECURITY_ERRORS.CORRUPT_BACKUP_DETECTED;
      throw err;
    }

    // Validate SHA-256 Checksum
    const actualChecksum = crypto.createHash('sha256').update(decryptedJson).digest('hex');
    if (actualChecksum !== archive.checksum) {
      const err = new Error(`Backup Checksum Mismatch: expected ${archive.checksum}, got ${actualChecksum} (INV-13-11)`);
      err.code = SECURITY_ERRORS.CORRUPT_BACKUP_DETECTED;
      err.expectedChecksum = archive.checksum;
      err.actualChecksum = actualChecksum;
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(decryptedJson, jsonReviver);
    } catch (e) {
      const err = new Error('Backup payload is not valid JSON');
      err.code = SECURITY_ERRORS.CORRUPT_BACKUP_DETECTED;
      throw err;
    }

    return {
      valid: true,
      backupId: archive.id,
      marker: archive.marker,
      tablesCount: Object.keys(parsed.tables || {}).length
    };
  }

  /**
   * Restores an encrypted backup into a clean target database instance (Requirement 34)
   */
  static restoreSnapshot(archive, targetDb, { keyManager = defaultKeyManager } = {}) {
    const startTime = Date.now();

    // 1. Strict verification prior to restore (Requirement 37)
    this.verifyBackupArchive(archive, { keyManager });

    // 2. Decrypt verified payload
    const decryptedJson = keyManager.decrypt(archive.encryptedPayload);
    const parsed = JSON.parse(decryptedJson, jsonReviver);

    // 3. Clear target database tables
    for (const map of Object.values(targetDb.tables)) {
      map.clear();
    }

    // 4. Restore tables
    for (const [tableName, entries] of Object.entries(parsed.tables)) {
      if (!targetDb.tables[tableName]) {
        targetDb.tables[tableName] = new Map();
      }
      for (const [key, value] of entries) {
        targetDb.tables[tableName].set(key, value);
      }
    }

    const durationMs = Date.now() - startTime;
    return {
      status: 'RESTORE_SUCCESS',
      backupId: archive.id,
      restoredAt: new Date().toISOString(),
      durationMs,
      marker: archive.marker
    };
  }

  /**
   * Executes synthetic Point-in-Time Recovery (PITR) up to target transaction marker (Requirement 35, 41)
   */
  static restorePointInTime(baselineArchive, journalEntries, targetMarker, targetDb, { keyManager = defaultKeyManager } = {}) {
    // 1. Restore clean baseline
    this.restoreSnapshot(baselineArchive, targetDb, { keyManager });

    // 2. Replay journal transactions strictly up to target marker
    let replayedCount = 0;
    for (const entry of journalEntries) {
      if (entry.marker === targetMarker) {
        // Target reached: apply and stop
        this._applyJournalDelta(targetDb, entry);
        replayedCount++;
        break;
      }
      this._applyJournalDelta(targetDb, entry);
      replayedCount++;
    }

    return {
      status: 'PITR_SUCCESS',
      targetMarker,
      replayedTransactions: replayedCount
    };
  }

  static _applyJournalDelta(db, entry) {
    if (entry.table && entry.action === 'INSERT' && entry.record) {
      if (!db.tables[entry.table]) db.tables[entry.table] = new Map();
      db.tables[entry.table].set(entry.record.id, entry.record);
    }
  }

  /**
   * Simulates synthetic ransomware destructive corruption (Requirement 36)
   */
  static simulateDestructiveWipe(db, { corruptOnlyTargetTables = null } = {}) {
    const affected = [];
    for (const [tableName, map] of Object.entries(db.tables)) {
      if (!corruptOnlyTargetTables || corruptOnlyTargetTables.includes(tableName)) {
        affected.push(tableName);
        for (const [key, val] of map.entries()) {
          map.set(key, { ...val, corrupted: true, data: 'ENCRYPTED_BY_SYNTHETIC_RANSOMWARE_DEMO' });
        }
      }
    }
    return { corruptedTables: affected };
  }
}

module.exports = {
  BackupRecoveryService
};
