const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  InvoiceService,
  PaymentService,
  SubscriptionService,
  EntitlementEngine,
  SUBSCRIPTION_STATUSES,
  INVOICE_STATUSES,
  BILLING_ERRORS,
  FEATURES
} = require('../src/billing');

test('Phase 12 — Payment Webhooks & Amount Verification (INV-12-06, INV-12-07, Critical Test 60)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Critical Test 60: Webhook replay x20 produces 1 payment, 1 transition, 0 duplicate credit (INV-12-06)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Create subscription in PAST_DUE
      const sub = await SubscriptionService.createSubscription(tx, {
        tenantId,
        planVersionId: 'STARTER_V1',
        status: SUBSCRIPTION_STATUSES.PAST_DUE
      });

      // Create invoice for 149000 centimes (1,490 DZD)
      const inv = await InvoiceService.createInvoice(tx, {
        subscriptionId: sub.id,
        planVersionId: 'STARTER_V1',
        lines: [{ description: 'Starter Monthly', unitPriceCents: 149000n, quantity: 1 }]
      });
      const invoiceId = inv.invoice.id;

      // Send 20 concurrent or repeated webhook calls with identical externalEventId
      const webhookPayload = {
        invoiceId,
        amountCents: 149000n,
        currency: 'DZD',
        status: 'succeeded'
      };

      const results = [];
      for (let i = 0; i < 20; i++) {
        const res = await PaymentService.processPaymentWebhook(tx, {
          provider: 'CHARGILY',
          externalEventId: 'EVT-WEBHOOK-REPLAY-001',
          payload: webhookPayload
        });
        results.push(res);
      }

      // Assert exactly 1 was processed and 19 were replayed
      const processedCount = results.filter(r => !r.replayed).length;
      const replayedCount = results.filter(r => r.replayed).length;
      assert.strictEqual(processedCount, 1);
      assert.strictEqual(replayedCount, 19);

      // Verify DB: exactly 1 payment record
      const payments = await tx.query('payments', p => p.invoice_id === invoiceId);
      assert.strictEqual(payments.length, 1);

      // Verify subscription transitioned to ACTIVE
      const updatedSub = await tx.findById('subscriptions', sub.id);
      assert.strictEqual(updatedSub.status, SUBSCRIPTION_STATUSES.ACTIVE);

      // Verify invoice marked PAID
      const updatedInv = await tx.findById('invoices', invoiceId);
      assert.strictEqual(updatedInv.status, INVOICE_STATUSES.PAID);
    });
  });

  await t.test('2. Critical Test 60 (Part 2): Webhook with amount mismatch is rejected without entitlement escalation (INV-12-07)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Create new invoice for 149000 centimes
      const inv = await InvoiceService.createInvoice(tx, {
        planVersionId: 'STARTER_V1',
        lines: [{ description: 'Starter Monthly', unitPriceCents: 149000n, quantity: 1 }]
      });
      const invoiceId = inv.invoice.id;

      // Webhook sends 1490000 centimes (tampered amount)
      await assert.rejects(
        async () => PaymentService.processPaymentWebhook(tx, {
          provider: 'CHARGILY',
          externalEventId: 'EVT-TAMPER-001',
          payload: {
            invoiceId,
            amountCents: 1490000n, // 14,900 DZD instead of 1,490 DZD
            currency: 'DZD'
          }
        }),
        (err) => {
          assert.strictEqual(err.code, BILLING_ERRORS.PAYMENT_MISMATCH);
          return true;
        }
      );

      // Verify NO payment was inserted
      const payments = await tx.query('payments', p => p.invoice_id === invoiceId);
      assert.strictEqual(payments.length, 0);

      // Verify invoice remained ISSUED (not PAID)
      const freshInv = await tx.findById('invoices', invoiceId);
      assert.strictEqual(freshInv.status, INVOICE_STATUSES.ISSUED);
    });
  });
});
