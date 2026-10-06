const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  InvoiceService,
  INVOICE_STATUSES
} = require('../src/billing');

test('Phase 12 — Invoice Immutability, Monotonic Numbering & Credit Notes (INV-12-04, INV-12-05, Requirement 53)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Monotonic invoice numbering per tenant (Requirement 53)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const inv1 = await InvoiceService.createInvoice(tx, {
        planVersionId: 'STARTER_V1',
        lines: [{ description: 'BoutiqFlow STARTER Monthly', unitPriceCents: 149000n, quantity: 1 }]
      });
      assert.match(inv1.invoice.invoice_number, /^BF-\d{4}-000001$/);

      const inv2 = await InvoiceService.createInvoice(tx, {
        planVersionId: 'PRO_V1',
        lines: [{ description: 'BoutiqFlow PRO Monthly', unitPriceCents: 299000n, quantity: 1 }]
      });
      assert.match(inv2.invoice.invoice_number, /^BF-\d{4}-000002$/);
    });
  });

  await t.test('2. Issued invoices are strictly immutable against price/currency/tax tampering (INV-12-04)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const inv = await InvoiceService.createInvoice(tx, {
        planVersionId: 'STARTER_V1',
        lines: [{ description: 'Starter Plan', unitPriceCents: 149000n, quantity: 1 }]
      });
      const invoiceId = inv.invoice.id;

      // Direct mutation attempt on total_cents
      await assert.rejects(
        async () => tx.update('invoices', invoiceId, { total_cents: 999900n }),
        /Invoice Immutability Violation: Invoices are immutable after issuance \(INV-12-04\)/
      );

      // Direct mutation attempt on currency
      await assert.rejects(
        async () => tx.update('invoices', invoiceId, { currency: 'EUR' }),
        /Invoice Immutability Violation: Invoices are immutable after issuance \(INV-12-04\)/
      );

      // Direct deletion attempt
      await assert.rejects(
        async () => tx.delete('invoices', invoiceId),
        /Audit Trail Violation: invoices records cannot be deleted/
      );
    });
  });

  await t.test('3. Invoice correction via Credit Note & formal voiding (INV-12-05)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const inv = await InvoiceService.createInvoice(tx, {
        planVersionId: 'STARTER_V1',
        lines: [{ description: 'Starter Plan', unitPriceCents: 149000n, quantity: 1 }]
      });
      const invoiceId = inv.invoice.id;

      // Issue Credit Note
      const creditNote = await InvoiceService.createCreditNote(tx, {
        invoiceId,
        amountCents: 149000n,
        reason: 'CUSTOMER_SATISFACTION_REFUND'
      });
      assert.ok(creditNote.id);
      assert.strictEqual(creditNote.amount_cents, 149000n);
      assert.match(creditNote.credit_note_number, /^CN-\d{4}-000001$/);

      // Original invoice total remains intact and immutable
      const fetched = await tx.findById('invoices', invoiceId);
      assert.strictEqual(fetched.total_cents, 149000n);

      // Void invoice formally
      const voided = await InvoiceService.voidInvoice(tx, invoiceId, 'REPLACED_BY_ANNUAL');
      assert.strictEqual(voided.status, INVOICE_STATUSES.VOIDED);
      assert.ok(voided.voided_at);
    });
  });
});
