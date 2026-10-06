const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  ProcessingJournalService,
  PROCESSING_OPERATIONS,
  COMPLIANCE_ERRORS
} = require('../src/compliance');

test('Phase 11 — Journal Cryptographic Chaining & Tamper Detection (INV-11-07)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Valid journal chain of 5 entries verifies successfully', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      for (let i = 1; i <= 5; i++) {
        await ProcessingJournalService.logOperation(tx, {
          actorId: `user_${i}`,
          operation: PROCESSING_OPERATIONS.VIEWED,
          purpose: `OPERATION_${i}`,
          dataSubjectId: `sub_${i}`
        });
      }

      const check = await ProcessingJournalService.verifyJournalIntegrity(tx, tenantId);
      assert.strictEqual(check.valid, true);
      assert.strictEqual(check.count, 5);
    });
  });

  await t.test('2. Detects payload tampering: JOURNAL_TAMPER_DETECTED (INV-11-07)', async () => {
    // Low-level table manipulation to simulate offline file tampering
    const rawTable = db.tables.processing_journal;
    let targetEntryKey = null;

    for (const [key, record] of rawTable.entries()) {
      if (record.tenant_id === tenantId && record.sequence === 3) {
        targetEntryKey = key;
        break;
      }
    }

    assert.ok(targetEntryKey);
    // Malicious actor alters purpose without recomputing hash
    const record = rawTable.get(targetEntryKey);
    record.purpose = 'MALICIOUS_ALTERATION';

    await db.withTenant({ tenantId }, async (tx) => {
      const check = await ProcessingJournalService.verifyJournalIntegrity(tx, tenantId);
      assert.strictEqual(check.valid, false);
      assert.strictEqual(check.error, COMPLIANCE_ERRORS.JOURNAL_TAMPER_DETECTED);
      assert.strictEqual(check.sequence, 3);
    });
  });

  await t.test('3. Detects deleted record / sequence gap: JOURNAL_SEQUENCE_GAP (INV-11-07)', async () => {
    const freshDb = new MahalDatabase();
    const freshTenant = generateUUIDv7();

    await freshDb.withTenant({ tenantId: freshTenant }, async (tx) => {
      for (let i = 1; i <= 3; i++) {
        await ProcessingJournalService.logOperation(tx, {
          actorId: `user_${i}`,
          operation: PROCESSING_OPERATIONS.VIEWED,
          purpose: `OPERATION_${i}`,
          dataSubjectId: `sub_${i}`
        });
      }
    });

    // Remove sequence 2
    const rawTable = freshDb.tables.processing_journal;
    for (const [key, record] of rawTable.entries()) {
      if (record.tenant_id === freshTenant && record.sequence === 2) {
        rawTable.delete(key);
        break;
      }
    }

    await freshDb.withTenant({ tenantId: freshTenant }, async (tx) => {
      const check = await ProcessingJournalService.verifyJournalIntegrity(tx, freshTenant);
      assert.strictEqual(check.valid, false);
      assert.strictEqual(check.error, COMPLIANCE_ERRORS.JOURNAL_SEQUENCE_GAP);
    });
  });
});
