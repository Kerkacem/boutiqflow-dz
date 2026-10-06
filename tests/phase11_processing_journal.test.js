const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  ProcessingJournalService,
  PROCESSING_OPERATIONS
} = require('../src/compliance');

test('Phase 11 — Processing Journal Independence & Immutability (INV-11-05, INV-11-06)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const cashierId = generateUUIDv7();

  let entry1Id = null;

  await t.test('1. Logs operations with Article 41 bis 3 metadata and sequence chaining', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const entry = await ProcessingJournalService.logOperation(tx, {
        actorId: cashierId,
        actorRole: 'CASHIER',
        operation: PROCESSING_OPERATIONS.VIEWED,
        dataSubjectType: 'CUSTOMER',
        dataSubjectId: 'cust_oran_555',
        purpose: 'POS_RECEIPT_VERIFICATION',
        ipAddress: '192.168.1.100',
        userAgent: 'BoutiqFlow-POS/1.0',
        details: { receiptId: 'REC-101' }
      });

      assert.ok(entry.id);
      entry1Id = entry.id;
      assert.strictEqual(entry.sequence, 1);
      assert.strictEqual(entry.previous_event_hash, 'GENESIS');
      assert.ok(entry.event_hash);
      assert.strictEqual(entry.operation, 'VIEWED');
    });
  });

  await t.test('2. Processing Journal is strictly immutable: Direct UPDATE & DELETE are blocked (INV-11-06)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Direct UPDATE must throw Audit Trail Violation
      await assert.rejects(
        async () => tx.update('processing_journal', entry1Id, { purpose: 'ALTERED_PURPOSE' }),
        /Audit Trail Violation: processing_journal records are strictly immutable/
      );

      // Direct DELETE must throw Audit Trail Violation
      await assert.rejects(
        async () => tx.delete('processing_journal', entry1Id),
        /Audit Trail Violation: processing_journal records cannot be deleted/
      );
    });
  });

  await t.test('3. Corrections are made via CORRECTION_EVENT while preserving original record (INV-11-06)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const correction = await ProcessingJournalService.logCorrection(tx, {
        originalEntryId: entry1Id,
        actorId: 'manager_123',
        actorRole: 'MANAGER',
        reason: 'Typo in receipt reference number',
        correctedDetails: { receiptId: 'REC-101-CORRECTED' }
      });

      assert.ok(correction.id);
      assert.strictEqual(correction.sequence, 2);
      assert.strictEqual(correction.purpose, 'JOURNAL_CORRECTION');

      // Original entry is intact and unmodified
      const original = await tx.findById('processing_journal', entry1Id);
      assert.strictEqual(original.purpose, 'POS_RECEIPT_VERIFICATION');
    });
  });
});
