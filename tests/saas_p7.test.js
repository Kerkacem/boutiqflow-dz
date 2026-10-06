const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  SUBSCRIPTION_STATUS,
  evaluateSubscriptionStatus,
  assertMutationAllowed,
  checkEntitlements,
  activateSubscription
} = require('../src/saas/subscriptions');
const { verifyChargilySignature, handleChargilyWebhook } = require('../src/saas/chargily');
const { createManualSubscriptionOrder, submitPaymentReceipt, approveManualPayment } = require('../src/saas/manual_billing');
const { exportTenantData, initiateTenantDeletion, startSuperAdminImpersonation } = require('../src/saas/admin');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase P7 — SaaS Layer, Subscriptions, Chargily Pay & Portability', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let subscriptionId = null;

  await t.test('Setup tenant subscription in 14-day trial mode', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const trialEndsAt = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
      const sub = await tx.insert('subscriptions', {
        plan_id: 'BASIC',
        status: SUBSCRIPTION_STATUS.TRIALING,
        trial_ends_at: trialEndsAt
      });
      subscriptionId = sub.id;

      const evalStatus = await evaluateSubscriptionStatus(sub);
      assert.strictEqual(evalStatus, SUBSCRIPTION_STATUS.TRIALING);
    });
  });

  await t.test('UAT-14: Subscription Lifecycle: Trial Expiry -> Grace (PAST_DUE) -> READ_ONLY Gate', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Simulate trial has expired 8 days ago (beyond 7-day grace)
      const pastTrial = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
      const pastGrace = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

      await tx.update('subscriptions', subscriptionId, {
        status: SUBSCRIPTION_STATUS.PAST_DUE,
        trial_ends_at: pastTrial,
        grace_period_ends_at: pastGrace
      });

      const sub = await tx.findById('subscriptions', subscriptionId);
      const evalStatus = await evaluateSubscriptionStatus(sub);
      assert.strictEqual(evalStatus, SUBSCRIPTION_STATUS.READ_ONLY, 'Must transition to READ_ONLY once grace expires');

      // Update to READ_ONLY
      await tx.update('subscriptions', subscriptionId, { status: SUBSCRIPTION_STATUS.READ_ONLY });
      const readOnlySub = await tx.findById('subscriptions', subscriptionId);

      // Verify mutations are strictly blocked
      assert.throws(
        () => assertMutationAllowed(readOnlySub),
        (err) => err.statusCode === 403 && err.code === 'SUBSCRIPTION_READ_ONLY'
      );
    });
  });

  await t.test('UAT-14: Manual BaridiMob/CCP Payment Flow & Admin Reactivation', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. User orders 3 months renewal on BASIC plan (1,500 DA * 3 = 4,500 DA = 450,000 centimes)
      const order = await createManualSubscriptionOrder(tx, {
        subscriptionId,
        planId: 'BASIC',
        monthsCount: 3
      });

      assert.ok(order.invoiceId);
      assert.strictEqual(order.amountCentimes, 450000n);
      assert.ok(order.baridiMobRip);

      // 2. User uploads receipt
      await submitPaymentReceipt(tx, {
        invoiceId: order.invoiceId,
        paymentReference: 'VIR-CCP-987654',
        receiptUrl: 'https://storage.mahal.dz/receipts/rec_001.jpg'
      });

      // 3. Super-admin reviews and approves
      const superAdminId = generateUUIDv7();
      const approval = await approveManualPayment(tx, {
        invoiceId: order.invoiceId,
        superAdminUserId: superAdminId
      });
      assert.strictEqual(approval.approved, true);

      // Verify subscription reactivated to ACTIVE
      const activeSub = await tx.findById('subscriptions', subscriptionId);
      assert.strictEqual(activeSub.status, SUBSCRIPTION_STATUS.ACTIVE);
      assert.ok(new Date(activeSub.current_period_ends_at) > new Date());
    });
  });

  await t.test('UAT-14: Chargily Pay V2 Webhooks (Signature, Forgery Rejection & Replay Protection)', async () => {
    const webhookSecret = 'test_chargily_webhook_secret_key_abc123';

    await db.withTenant({ tenantId }, async (tx) => {
      // Create pending invoice for 1 month PRO plan (3,000 DA = 300,000 centimes)
      const invoice = await tx.insert('subscription_invoices', {
        subscription_id: subscriptionId,
        invoice_number: 'FAC-CHARGILY-001',
        amount_centimes: 300000n,
        payment_method: 'CHARGILY_PAY',
        status: 'PENDING',
        months_count: 1
      });

      const eventPayload = {
        id: 'evt_chargily_998877',
        data: {
          id: 'ch_checkout_123',
          status: 'paid',
          amount: 300000,
          currency: 'dzd',
          metadata: { invoice_id: invoice.id }
        }
      };

      const rawJson = JSON.stringify(eventPayload);
      const validSignature = crypto.createHmac('sha256', webhookSecret).update(rawJson).digest('hex');
      const forgedSignature = crypto.createHmac('sha256', 'wrong_secret').update(rawJson).digest('hex');

      // 1. Forged Signature: Must be rejected with 401 Unauthorized
      await assert.rejects(
        async () => {
          await handleChargilyWebhook(tx, {
            rawBody: rawJson,
            signature: forgedSignature,
            secret: webhookSecret,
            payload: eventPayload
          });
        },
        /Invalid Chargily signature/
      );

      // 2. Valid Webhook: Activates subscription
      const webhookResult = await handleChargilyWebhook(tx, {
        rawBody: rawJson,
        signature: validSignature,
        secret: webhookSecret,
        payload: eventPayload
      });

      assert.strictEqual(webhookResult.status, 'success');
      assert.strictEqual(webhookResult.activated, true);

      // Verify invoice marked PAID
      const updatedInvoice = await tx.findById('subscription_invoices', invoice.id);
      assert.strictEqual(updatedInvoice.status, 'PAID');

      // 3. Replay Attack: Resending identical webhook is safely recognized as already processed
      const replayResult = await handleChargilyWebhook(tx, {
        rawBody: rawJson,
        signature: validSignature,
        secret: webhookSecret,
        payload: eventPayload
      });

      assert.strictEqual(replayResult.status, 'already_processed', 'Replayed webhook must be caught idempotently');
    });
  });

  await t.test('Entitlement Limits: Maximum Users per Plan', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const sub = await tx.findById('subscriptions', subscriptionId);
      // Basic plan allows max 2 users
      await tx.insert('users', { email: 'user1@shop.dz', name: 'User 1', role: 'cashier', password_hash: 'x' });
      await tx.insert('users', { email: 'user2@shop.dz', name: 'User 2', role: 'cashier', password_hash: 'x' });

      // Trying to add 3rd user
      await assert.rejects(
        async () => {
          await checkEntitlements(tx, sub, 'users');
        },
        /Plan limit reached: Maximum 2 users allowed/
      );
    });
  });

  await t.test('UAT-16: Full Tenant Data Portability Export & 30-Day Soft Deletion', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Full Tenant Export
      const exportArchive = await exportTenantData(tx);
      assert.ok(exportArchive.catalog);
      assert.ok(exportArchive.inventory);
      assert.ok(exportArchive.sales);
      assert.ok(exportArchive.customers);
      assert.ok(exportArchive.finance);
      assert.strictEqual(exportArchive.tenantId, tenantId);

      // Verify export was audit logged
      const audit = await tx.query('audit_logs', a => a.action === 'data:export');
      assert.ok(audit.length > 0);

      // 2. 30-Day Soft Deletion Initiation
      const deletion = await initiateTenantDeletion(tx, 'Closing retail location');
      assert.strictEqual(deletion.status, 'SCHEDULED_FOR_DELETION');
      assert.strictEqual(deletion.retentionDays, 30);
      assert.ok(new Date(deletion.scheduledDeletionDate) > new Date());
    });
  });

  await t.test('Super-Admin Impersonation with Mandatory Audit Trail', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const adminId = generateUUIDv7();
      const result = await startSuperAdminImpersonation(tx, {
        superAdminId: adminId,
        targetTenantId: tenantId,
        reason: 'Ticket #4521 support check'
      });

      assert.strictEqual(result.impersonating, true);

      const audit = await tx.query('audit_logs', a => a.action === 'impersonation:start');
      assert.strictEqual(audit.length, 1);
      assert.ok(audit[0].metadata.includes('Ticket #4521'));
    });
  });
});
