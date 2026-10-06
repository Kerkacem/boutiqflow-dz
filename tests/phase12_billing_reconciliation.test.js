const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  InvoiceService,
  SubscriptionService,
  BillingReconciliationService,
  SUBSCRIPTION_STATUSES,
  INVOICE_STATUSES
} = require('../src/billing');

test('Phase 12 — Billing Reconciliation & Recovery (INV-12-21, Requirements 55 & 56)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Recover missing payment when webhook was lost during network timeout (Requirement 55)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Subscription in PAST_DUE
      const sub = await SubscriptionService.createSubscription(tx, {
        tenantId,
        planVersionId: 'STARTER_V1',
        status: SUBSCRIPTION_STATUSES.PAST_DUE
      });

      // Invoice created but unpaid (issued)
      const inv = await InvoiceService.createInvoice(tx, {
        subscriptionId: sub.id,
        planVersionId: 'STARTER_V1',
        lines: [{ description: 'Starter Plan', unitPriceCents: 149000n, quantity: 1 }]
      });
      const invoiceNumber = inv.invoice.invoice_number;

      // Provider succeeded externally, but webhook never arrived at BoutiqFlow
      const providerStream = [
        {
          invoiceNumber,
          amountCents: 149000n,
          currency: 'DZD',
          provider: 'CHARGILY',
          providerPaymentId: 'CHARG_EXT_001'
        }
      ];

      // Run reconciliation
      const reconResult = await BillingReconciliationService.runReconciliation(tx, {
        providerRecords: providerStream
      });

      assert.strictEqual(reconResult.missingPaymentsReconciled, 1);
      assert.strictEqual(reconResult.discrepanciesCount, 0);

      // Verify payment was recorded
      const payments = await tx.query('payments', p => p.invoice_id === inv.invoice.id);
      assert.strictEqual(payments.length, 1);

      // Verify invoice marked PAID
      const updatedInv = await tx.findById('invoices', inv.invoice.id);
      assert.strictEqual(updatedInv.status, INVOICE_STATUSES.PAID);

      // Verify subscription activated
      const updatedSub = await tx.findById('subscriptions', sub.id);
      assert.strictEqual(updatedSub.status, SUBSCRIPTION_STATUSES.ACTIVE);
    });
  });

  await t.test('2. Daily reconciliation detects amount mismatch and unknown invoice (Requirement 56)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const inv = await InvoiceService.createInvoice(tx, {
        planVersionId: 'STARTER_V1',
        lines: [{ description: 'Starter Plan', unitPriceCents: 149000n, quantity: 1 }]
      });

      const providerRecords = [
        // Mismatched amount
        {
          invoiceNumber: inv.invoice.invoice_number,
          amountCents: 99000n, // Expected 149000n
          currency: 'DZD'
        },
        // Unknown invoice
        {
          invoiceNumber: 'BF-9999-999999',
          amountCents: 149000n,
          currency: 'DZD'
        }
      ];

      const res = await BillingReconciliationService.runReconciliation(tx, { providerRecords });
      assert.strictEqual(res.amountMismatchesDetected, 1);
      assert.strictEqual(res.discrepanciesCount, 2);

      const mismatch = res.discrepancies.find(d => d.type === 'AMOUNT_MISMATCH');
      assert.ok(mismatch);
      assert.strictEqual(mismatch.invoiceId, inv.invoice.id);
    });
  });
});
