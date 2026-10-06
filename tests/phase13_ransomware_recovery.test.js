const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { BackupRecoveryService } = require('../src/security');

test('Phase 13 — Synthetic Ransomware Recovery & Measured RTO (INV-13-12, INV-13-27, Requirements 36 & 42)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  // 1. Seed complete retail state (products, variants, inventory, sales)
  await db.withTenant({ tenantId }, async (tx) => {
    await tx.insert('products', { id: 'P-101', name: 'Robe Karakou Gold' });
    await tx.insert('product_variants', { id: 'V-101', sku: 'KG-01', product_id: 'P-101' });
    await tx.insert('sales', { id: 'S-101', total_centimes: 1800000n });
  });

  // 2. Scheduled clean backup snapshot
  const cleanBackup = BackupRecoveryService.createBackup(db, { backupType: 'FULL' });

  await t.test('1. Ransomware simulation corrupts tables; restore recovers 100% of state with measured RTO < 3 min (Requirements 36 & 42)', async () => {
    const startTime = Date.now();

    // STEP A: Simulated destructive ransomware attack
    const corruptResult = BackupRecoveryService.simulateDestructiveWipe(db, {
      corruptOnlyTargetTables: ['products', 'product_variants', 'sales']
    });
    assert.ok(corruptResult.corruptedTables.length > 0);

    // Verify data is currently corrupted in database
    const corruptedProduct = db.tables.products.get('P-101');
    assert.strictEqual(corruptedProduct.corrupted, true);

    // STEP B: Containment & Restore
    const restoredDb = new MahalDatabase();
    const restoreResult = BackupRecoveryService.restoreSnapshot(cleanBackup, restoredDb);
    assert.strictEqual(restoreResult.status, 'RESTORE_SUCCESS');

    // STEP C: Verification of restored data
    const restoredProduct = restoredDb.tables.products.get('P-101');
    assert.strictEqual(restoredProduct.name, 'Robe Karakou Gold');
    assert.strictEqual(restoredProduct.corrupted, undefined);

    const restoredSale = restoredDb.tables.sales.get('S-101');
    assert.strictEqual(restoredSale.total_centimes, 1800000n);

    // STEP D: Measured Recovery Time Objective (RTO)
    const totalRecoveryTimeMs = Date.now() - startTime;
    // RTO must be well under target of 60 seconds / 3 minutes in automated environment
    assert.ok(totalRecoveryTimeMs < 10000, `Measured RTO was ${totalRecoveryTimeMs} ms, expected < 10,000 ms`);
  });
});
