const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { BackupRecoveryService } = require('../src/security');

test('Phase 13 — Point-in-Time Recovery (PITR) & Measured RPO (INV-13-12, INV-13-27, Requirements 35 & 41)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  // T0: Initial Good Baseline
  await db.withTenant({ tenantId }, async (tx) => {
    await tx.insert('products', { id: 'PROD-001', name: 'Robe Blanche' });
  });

  const baselineBackup = BackupRecoveryService.createBackup(db, { backupType: 'FULL' });

  // T1: Legitimate Transaction Marker RECOVERY_MARKER_001
  const journalDeltas = [
    {
      marker: 'TX_LEGITIMATE_01',
      table: 'products',
      action: 'INSERT',
      record: { id: 'PROD-002', tenant_id: tenantId, name: 'Caftan Soie' }
    },
    {
      marker: 'RECOVERY_MARKER_001',
      table: 'products',
      action: 'INSERT',
      record: { id: 'PROD-003', tenant_id: tenantId, name: 'Karakou Moderne' }
    },
    // T2: Malicious / Corrupted Transaction AFTER the marker
    {
      marker: 'TX_MALICIOUS_CORRUPT',
      table: 'products',
      action: 'INSERT',
      record: { id: 'PROD-HACKED', tenant_id: tenantId, name: 'RANSOMWARE_PAYLOAD' }
    }
  ];

  await t.test('1. Point-in-Time Recovery successfully restores exactly up to RECOVERY_MARKER_001 (Requirement 35 & 41)', () => {
    const recoveryDb = new MahalDatabase();

    const pitrResult = BackupRecoveryService.restorePointInTime(
      baselineBackup,
      journalDeltas,
      'RECOVERY_MARKER_001',
      recoveryDb
    );

    assert.strictEqual(pitrResult.status, 'PITR_SUCCESS');
    assert.strictEqual(pitrResult.targetMarker, 'RECOVERY_MARKER_001');
    assert.strictEqual(pitrResult.replayedTransactions, 2);

    // Verify: PROD-001 (from baseline) is present
    const p1 = recoveryDb.tables.products.get('PROD-001');
    assert.ok(p1);

    // Verify: PROD-002 and PROD-003 (up to marker) are present
    const p2 = recoveryDb.tables.products.get('PROD-002');
    const p3 = recoveryDb.tables.products.get('PROD-003');
    assert.ok(p2);
    assert.ok(p3);

    // Verify: Malicious PROD-HACKED is strictly ABSENT (measured RPO preserved cleanly)
    const hacked = recoveryDb.tables.products.get('PROD-HACKED');
    assert.strictEqual(hacked, undefined, 'Corrupt/Malicious mutation after marker must be absent');
  });
});
