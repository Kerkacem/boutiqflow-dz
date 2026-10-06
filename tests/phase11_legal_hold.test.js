const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  RetentionEngine,
  ProcessingJournalService
} = require('../src/compliance');

test('Phase 11 — Legal Hold Immunity & Financial Ledger Retention Chaos (INV-11-09, INV-11-12, Section 65)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let heldCustomerId = null;
  let regularCustomerId = null;
  let saleId = null;
  let holdId = null;

  await t.test('Setup: Seed held customer, normal expired customer, historical sale, and legal hold', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Held customer
      const custHeld = await tx.insert('customers', {
        name: 'Tarek Belmadi (Litigation Pending)',
        phone: '0555333333',
        address: 'Bordj El Kiffan',
        retention_expired: true
      });
      heldCustomerId = custHeld.id;

      // Regular customer
      const custRegular = await tx.insert('customers', {
        name: 'Mourad Meghni',
        phone: '0555444444',
        address: 'Hydra',
        retention_expired: true
      });
      regularCustomerId = custRegular.id;

      // Historical completed sale
      const sale = await tx.insert('sales', {
        id: generateUUIDv7(),
        total_cents: 800000n,
        status: 'COMPLETED',
        retention_expired: true
      });
      saleId = sale.id;

      // Create Legal Hold on held customer
      const hold = await RetentionEngine.createLegalHold(tx, {
        name: 'Commercial Court Dispute #2026/89',
        reason: 'Pending tax authority audit and invoice contestation',
        referenceType: 'CUSTOMER',
        referenceId: heldCustomerId
      });
      holdId = hold.id;
      assert.strictEqual(hold.status, 'ACTIVE');
    });
  });

  await t.test('1. Retention Chaos: Active Legal Hold prevents deletion of held data (INV-11-09)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const run1 = await RetentionEngine.runRetentionJob(tx);

      assert.strictEqual(run1.processedCount, 1, 'Regular customer should be processed');
      assert.strictEqual(run1.preservedUnderHoldCount, 1, 'Held customer must be preserved under active hold');
      assert.strictEqual(run1.financialPreservedCount, 1, 'Historical sale must be preserved unconditionally');

      // Verify held customer data was NOT altered
      const heldCustAfter = await tx.findById('customers', heldCustomerId);
      assert.strictEqual(heldCustAfter.name, 'Tarek Belmadi (Litigation Pending)');
      assert.strictEqual(heldCustAfter.address, 'Bordj El Kiffan');

      // Verify regular customer was anonymized
      const regCustAfter = await tx.findById('customers', regularCustomerId);
      assert.strictEqual(regCustAfter.name, 'Client Anonymisé');

      // Verify historical sale was NOT deleted
      const saleAfter = await tx.findById('sales', saleId);
      assert.ok(saleAfter);
      assert.strictEqual(saleAfter.total_cents, 800000n);
    });
  });

  await t.test('2. Releasing Legal Hold allows subsequent retention processing with audit trail (INV-11-09)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      await RetentionEngine.releaseLegalHold(tx, holdId, 'Dispute resolved in commercial court');

      const run2 = await RetentionEngine.runRetentionJob(tx);
      assert.strictEqual(run2.processedCount, 1, 'Formerly held customer is now processed');
      assert.strictEqual(run2.preservedUnderHoldCount, 0);

      const heldCustAfterRelease = await tx.findById('customers', heldCustomerId);
      assert.strictEqual(heldCustAfterRelease.name, 'Client Anonymisé');

      // Verify journal chain integrity preserved throughout chaos
      const integrity = await ProcessingJournalService.verifyJournalIntegrity(tx, tenantId);
      assert.strictEqual(integrity.valid, true);
    });
  });
});
