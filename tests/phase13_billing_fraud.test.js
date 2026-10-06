const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  PaymentService,
  InvoiceService,
  SubscriptionService,
  EntitlementEngine,
  BILLING_ERRORS,
  FEATURES,
  SUBSCRIPTION_STATUSES
} = require('../src/billing');

test('Phase 13 — Billing Fraud & Entitlement Escalation Red Team (INV-13-22, Requirement 75)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Fake webhook with amount mismatch does not escalate entitlements (INV-13-22, Requirement 75)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Subscription in PAST_DUE on STARTER_V1
      const sub = await SubscriptionService.createSubscription(tx, {
        tenantId,
        planVersionId: 'STARTER_V1',
        status: SUBSCRIPTION_STATUSES.PAST_DUE
      });

      const inv = await InvoiceService.createInvoice(tx, {
        subscriptionId: sub.id,
        planVersionId: 'STARTER_V1',
        lines: [{ description: 'Starter Plan', unitPriceCents: 149000n, quantity: 1 }]
      });

      // Attacker sends fake webhook with 1 centime
      await assert.rejects(
        async () => PaymentService.processPaymentWebhook(tx, {
          provider: 'CHARGILY',
          externalEventId: 'EVT-FRAUD-001',
          payload: {
            invoiceId: inv.invoice.id,
            amountCents: 100n, // 1 DA instead of 1,490 DA
            currency: 'DZD'
          }
        }),
        (err) => {
          assert.strictEqual(err.code, BILLING_ERRORS.PAYMENT_MISMATCH);
          return true;
        }
      );

      // Verify subscription is STILL past due, NOT activated
      const currentSub = await tx.findById('subscriptions', sub.id);
      assert.strictEqual(currentSub.status, SUBSCRIPTION_STATUSES.PAST_DUE);
    });
  });

  await t.test('2. Currency mismatch webhook is rejected without entitlement activation (Requirement 75)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const sub = (await tx.query('subscriptions', s => s.tenant_id === tenantId))[0];
      const inv = await InvoiceService.createInvoice(tx, {
        subscriptionId: sub.id,
        planVersionId: 'STARTER_V1',
        lines: [{ description: 'Starter Plan', unitPriceCents: 149000n, quantity: 1 }]
      });

      // Attacker sends 149000 EUR instead of DZD
      await assert.rejects(
        async () => PaymentService.processPaymentWebhook(tx, {
          provider: 'CHARGILY',
          externalEventId: 'EVT-FRAUD-EUR',
          payload: {
            invoiceId: inv.invoice.id,
            amountCents: 149000n,
            currency: 'EUR'
          }
        }),
        (err) => {
          assert.strictEqual(err.code, BILLING_ERRORS.PAYMENT_MISMATCH);
          return true;
        }
      );
    });
  });

  await t.test('3. Client claiming PRO/BUSINESS directly is rejected by EntitlementEngine (Critical Test 59)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Client claims plan=BUSINESS to access FEATURE_API
      await assert.rejects(
        async () => EntitlementEngine.evaluateClientClaim(tx, tenantId, {
          claimedPlanCode: 'BUSINESS',
          featureCode: FEATURES.FEATURE_API
        }),
        (err) => {
          assert.strictEqual(err.code, BILLING_ERRORS.PLAN_FORGED);
          return true;
        }
      );
    });
  });
});
