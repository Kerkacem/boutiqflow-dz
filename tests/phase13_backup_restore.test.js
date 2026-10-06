const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  BackupRecoveryService,
  KeyManagementService,
  KEY_TYPES,
  SECURITY_ERRORS
} = require('../src/security');

test('Phase 13 — Encrypted Backup, Checksum & Cold Restore (INV-13-11, INV-13-12, INV-13-13, INV-13-28)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  // 1. Seed records across Tenant A and Tenant B
  await db.withTenant({ tenantId: tenantA }, async (tx) => {
    await tx.insert('products', { id: 'PROD-A1', name: 'Robe Algeroise' });
    await tx.insert('sales', { id: 'SALE-A1', total_centimes: 1200000n });
  });

  await db.withTenant({ tenantId: tenantB }, async (tx) => {
    await tx.insert('products', { id: 'PROD-B1', name: 'Karakou Moderne' });
    await tx.insert('sales', { id: 'SALE-B1', total_centimes: 850000n });
  });

  await t.test('1. Creates encrypted backup snapshot with SHA-256 checksum (INV-13-11)', () => {
    const archive = BackupRecoveryService.createBackup(db, { backupType: 'FULL' });
    assert.ok(archive.id);
    assert.strictEqual(archive.backupType, 'FULL');
    assert.ok(archive.checksum);
    assert.strictEqual(archive.checksum.length, 64);
    assert.ok(archive.encryptedPayload);

    // Verify archive passes integrity validation
    const verification = BackupRecoveryService.verifyBackupArchive(archive);
    assert.strictEqual(verification.valid, true);
    assert.ok(verification.tablesCount > 0);
  });

  await t.test('2. Tampered or corrupted backup strictly blocks restoration (INV-13-11, Requirement 37)', () => {
    const archive = BackupRecoveryService.createBackup(db);

    // Tamper with checksum
    const tamperedChecksumArchive = { ...archive, checksum: 'badbeef'.repeat(9) + '0' };
    assert.throws(
      () => BackupRecoveryService.verifyBackupArchive(tamperedChecksumArchive),
      (err) => {
        assert.strictEqual(err.code, SECURITY_ERRORS.CORRUPT_BACKUP_DETECTED);
        return true;
      }
    );

    // Wrong encryption key
    const differentKms = new KeyManagementService();
    assert.throws(
      () => BackupRecoveryService.verifyBackupArchive(archive, { keyManager: differentKms }),
      (err) => {
        assert.strictEqual(err.code, SECURITY_ERRORS.CORRUPT_BACKUP_DETECTED);
        return true;
      }
    );
  });

  await t.test('3. Restore into clean database restores 100% of data and preserves RLS isolation (INV-13-13, INV-13-28)', async () => {
    const archive = BackupRecoveryService.createBackup(db);

    // Fresh target database
    const cleanDb = new MahalDatabase();

    const restoreRes = BackupRecoveryService.restoreSnapshot(archive, cleanDb);
    assert.strictEqual(restoreRes.status, 'RESTORE_SUCCESS');
    assert.ok(restoreRes.durationMs >= 0);

    // Verify Tenant A records restored
    await cleanDb.withTenant({ tenantId: tenantA }, async (tx) => {
      const prodA = await tx.findById('products', 'PROD-A1');
      assert.ok(prodA);
      assert.strictEqual(prodA.name, 'Robe Algeroise');

      // Tenant A cannot see Tenant B
      const prodB = await tx.findById('products', 'PROD-B1');
      assert.strictEqual(prodB, null);
    });

    // Verify Tenant B records restored & isolated
    await cleanDb.withTenant({ tenantId: tenantB }, async (tx) => {
      const prodB = await tx.findById('products', 'PROD-B1');
      assert.ok(prodB);
      assert.strictEqual(prodB.name, 'Karakou Moderne');

      const prodA = await tx.findById('products', 'PROD-A1');
      assert.strictEqual(prodA, null);
    });
  });
});
