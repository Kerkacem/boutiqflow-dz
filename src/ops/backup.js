const crypto = require('crypto');

/**
 * Encrypted Database Backup & Disaster Recovery Engine (UAT-15)
 * Standard: AES-256-GCM authenticated encryption with random IV and auth tag.
 */

function serializeDatabase(db) {
  const dump = {};
  for (const [tableName, map] of Object.entries(db.tables)) {
    dump[tableName] = Array.from(map.entries()).map(([k, v]) => {
      // Serialize BigInt values safely
      const cleanValue = JSON.parse(JSON.stringify(v, (key, value) =>
        typeof value === 'bigint' ? { __bigint: value.toString() } : value
      ));
      return [k, cleanValue];
    });
  }
  return JSON.stringify(dump);
}

function deserializeDatabase(jsonStr) {
  const parsed = JSON.parse(jsonStr, (key, value) => {
    if (value && typeof value === 'object' && value.__bigint !== undefined) {
      return BigInt(value.__bigint);
    }
    return value;
  });
  return parsed;
}

function createEncryptedBackup(db, secretKey) {
  if (!secretKey || secretKey.length < 16) {
    throw new Error('Encryption key must be at least 16 characters');
  }

  const rawData = serializeDatabase(db);
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const key = crypto.scryptSync(secretKey, 'mahal_backup_salt_2026', 32);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(rawData, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    payload: encrypted.toString('base64'),
    timestamp: new Date().toISOString()
  };
}

function restoreEncryptedBackup(db, backupArtifact, secretKey) {
  if (backupArtifact.algorithm !== 'aes-256-gcm') {
    throw new Error(`Unsupported backup algorithm: ${backupArtifact.algorithm}`);
  }

  const iv = Buffer.from(backupArtifact.iv, 'hex');
  const authTag = Buffer.from(backupArtifact.authTag, 'hex');
  const key = crypto.scryptSync(secretKey, 'mahal_backup_salt_2026', 32);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(backupArtifact.payload, 'base64')),
    decipher.final()
  ]).toString('utf8');

  const restoredData = deserializeDatabase(decrypted);

  // Atomic wipe and restore
  for (const [tableName, map] of Object.entries(db.tables)) {
    if (tableName === 'plans') continue; // Preserve global static plans
    map.clear();
  }

  for (const [tableName, entries] of Object.entries(restoredData)) {
    if (!db.tables[tableName]) {
      db.tables[tableName] = new Map();
    }
    for (const [k, v] of entries) {
      db.tables[tableName].set(k, v);
    }
  }

  return {
    success: true,
    restoredAt: new Date().toISOString(),
    tablesCount: Object.keys(restoredData).length
  };
}

module.exports = {
  createEncryptedBackup,
  restoreEncryptedBackup
};
