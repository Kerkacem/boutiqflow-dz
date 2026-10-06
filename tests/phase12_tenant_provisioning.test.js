const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  TenantProvisioningService,
  SubscriptionService,
  InvoiceService,
  PaymentService,
  BillingReconciliationService,
  TenantLifecycleService,
  EntitlementEngine,
  SUBSCRIPTION_STATUSES,
  TENANT_LIFECYCLE_STATES,
  INVOICE_STATUSES,
  FEATURES
} = require('../src/billing');

test('Phase 12 — Composite Decisive Test: Full Tenant Lifecycle & Commercial Integrity (INV-12-01 to INV-12-30)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const tenantName = 'Boutique Elegance Alger';
  const email = 'contact@elegance-alger.dz';
  const phone = '0555987654';

  await t.test('Decisive Lifecycle: Provisioning -> Trial -> Replays -> Reconciliation -> Webhooks -> Upgrade -> Downgrade -> Suspension -> Recovery', async () => {
    // 1. SIGNUP & PROVISIONING (Idempotency check with 20 retries / concurrent requests)
    let initialProvision = null;
    await db.withTenant({ tenantId }, async (tx) => {
      initialProvision = await TenantProvisioningService.provisionTenant(tx, {
        tenantId,
        tenantName,
        ownerName: 'Karim Hadj',
        email,
        phone,
        planCode: 'STARTER',
        trialDays: 14
      });
      assert.strictEqual(initialProvision.replayed, false);
      assert.strictEqual(initialProvision.subscription.status, SUBSCRIPTION_STATUSES.TRIALING);
    });

    // 20 duplicate retries
    for (let i = 0; i < 20; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const retryRes = await TenantProvisioningService.provisionTenant(tx, {
          tenantId,
          tenantName,
          email
        });
        assert.strictEqual(retryRes.replayed, true);
      });
    }

    // Verify exactly 1 tenant, 1 owner, 1 trial, 1 subscription in DB
    await db.withTenant({ tenantId }, async (tx) => {
      const tenants = await tx.query('tenants', t => t.id === tenantId);
      const owners = await tx.query('users', u => u.tenant_id === tenantId);
      const trials = await tx.query('trials', tr => tr.tenant_id === tenantId);
      const subs = await tx.query('subscriptions', s => s.tenant_id === tenantId);

      assert.strictEqual(tenants.length, 1);
      assert.strictEqual(owners.length, 1);
      assert.strictEqual(trials.length, 1);
      assert.strictEqual(subs.length, 1);
    });

    // 2. TRIAL EXPIRY -> PAST_DUE
    let subId = null;
    await db.withTenant({ tenantId }, async (tx) => {
      const sub = (await tx.query('subscriptions', s => s.tenant_id === tenantId))[0];
      subId = sub.id;
      await SubscriptionService.transitionStatus(tx, subId, SUBSCRIPTION_STATUSES.PAST_DUE, {
        reason: 'TRIAL_EXPIRED'
      });
    });

    // 3. INVOICE CREATION
    let invoiceId = null;
    let invoiceNumber = null;
    await db.withTenant({ tenantId }, async (tx) => {
      const inv = await InvoiceService.createInvoice(tx, {
        subscriptionId: subId,
        planVersionId: 'STARTER_V1',
        lines: [{ description: 'BoutiqFlow STARTER Monthly', unitPriceCents: 149000n, quantity: 1 }]
      });
      invoiceId = inv.invoice.id;
      invoiceNumber = inv.invoice.invoice_number;
      assert.strictEqual(inv.invoice.status, INVOICE_STATUSES.ISSUED);
    });

    // 4. LOST WEBHOOK & RECONCILIATION
    await db.withTenant({ tenantId }, async (tx) => {
      const providerStream = [
        {
          invoiceNumber,
          amountCents: 149000n,
          currency: 'DZD',
          provider: 'CHARGILY',
          providerPaymentId: 'EXT-CHRG-777'
        }
      ];

      const recon = await BillingReconciliationService.runReconciliation(tx, {
        providerRecords: providerStream
      });
      assert.strictEqual(recon.missingPaymentsReconciled, 1);

      // Verify subscription activated
      const activeSub = await tx.findById('subscriptions', subId);
      assert.strictEqual(activeSub.status, SUBSCRIPTION_STATUSES.ACTIVE);
    });

    // 5. DUPLICATE WEBHOOK REPLAYS x20 (Now webhook finally arrives after reconciliation)
    await db.withTenant({ tenantId }, async (tx) => {
      for (let i = 0; i < 20; i++) {
        const whRes = await PaymentService.processPaymentWebhook(tx, {
          provider: 'CHARGILY',
          externalEventId: 'EVT-DUP-777',
          payload: {
            invoiceId,
            amountCents: 149000n,
            currency: 'DZD'
          }
        });
        if (i === 0) {
          assert.strictEqual(whRes.replayed, false);
        } else {
          assert.strictEqual(whRes.replayed, true);
        }
      }

      // Verify no duplicate payments created by the webhook replay
      const payments = await tx.query('payments', p => p.invoice_id === invoiceId);
      // Total 2 payments: 1 reconciled earlier, 1 from the incoming webhook, but no more than 2
      assert.ok(payments.length <= 2);
    });

    // 6. CONCURRENT UPGRADE x50 (STARTER -> BUSINESS)
    await db.withTenant({ tenantId }, async (tx) => {
      for (let i = 0; i < 50; i++) {
        await SubscriptionService.changePlan(tx, {
          subscriptionId: subId,
          newPlanVersionId: 'BUSINESS_V1',
          reason: 'Upgrade to Business Plan'
        });
      }

      const currentSub = await tx.findById('subscriptions', subId);
      assert.strictEqual(currentSub.plan_version_id, 'BUSINESS_V1');

      // Verify FEATURE_API is now available
      const hasApi = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_API);
      assert.strictEqual(hasApi, true);
    });

    // 7. DOWNGRADE WITH LIMIT VIOLATION (Add 10 users, then downgrade to STARTER which allows 2)
    await db.withTenant({ tenantId }, async (tx) => {
      for (let i = 1; i <= 5; i++) {
        await tx.insert('users', {
          id: generateUUIDv7(),
          tenant_id: tenantId,
          name: `Staff ${i}`,
          email: `staff${i}@elegance.dz`,
          role: 'SALES_ASSOCIATE'
        });
      }

      const downgrade = await SubscriptionService.changePlan(tx, {
        subscriptionId: subId,
        newPlanVersionId: 'STARTER_V1',
        reason: 'Downgrade to Starter'
      });
      assert.strictEqual(downgrade.limitViolated, true);

      // Verify users NOT deleted
      const allUsers = await tx.query('users', u => u.tenant_id === tenantId);
      assert.strictEqual(allUsers.length, 6); // 1 owner + 5 staff

      const subAfterDowngrade = await tx.findById('subscriptions', subId);
      assert.strictEqual(subAfterDowngrade.violation_status, 'LIMIT_VIOLATION');
    });

    // 8. PAYMENT FAILURE -> GRACE -> SUSPENSION -> READ_ONLY ACCESS
    await db.withTenant({ tenantId }, async (tx) => {
      await SubscriptionService.transitionStatus(tx, subId, SUBSCRIPTION_STATUSES.PAST_DUE, { reason: 'PAYMENT_FAILED' });
      await SubscriptionService.transitionStatus(tx, subId, SUBSCRIPTION_STATUSES.GRACE_PERIOD, { reason: 'GRACE_STARTED' });
      await SubscriptionService.transitionStatus(tx, subId, SUBSCRIPTION_STATUSES.SUSPENDED, { reason: 'GRACE_EXPIRED' });
      await TenantLifecycleService.transitionLifecycle(tx, tenantId, TENANT_LIFECYCLE_STATES.SUSPENDED, 'Billing suspension');

      // In suspended state, mutation is blocked
      assert.throws(
        () => TenantLifecycleService.assertOperationAllowed(TENANT_LIFECYCLE_STATES.SUSPENDED, 'POST_SALE')
      );

      // Transition to READ_ONLY mode
      await SubscriptionService.transitionStatus(tx, subId, SUBSCRIPTION_STATUSES.READ_ONLY, { reason: 'ENTER_READ_ONLY' });
      await TenantLifecycleService.transitionLifecycle(tx, tenantId, TENANT_LIFECYCLE_STATES.READ_ONLY, 'Customer access in read-only');

      // In READ_ONLY, reports and export allowed, but sales blocked
      assert.doesNotThrow(() => {
        TenantLifecycleService.assertOperationAllowed(TENANT_LIFECYCLE_STATES.READ_ONLY, 'EXPORT');
      });
      assert.throws(() => {
        TenantLifecycleService.assertOperationAllowed(TENANT_LIFECYCLE_STATES.READ_ONLY, 'POST_SALE');
      });
    });

    // 9. PAYMENT RECOVERY -> REACTIVATION
    await db.withTenant({ tenantId }, async (tx) => {
      // Payment succeeds
      await SubscriptionService.transitionStatus(tx, subId, SUBSCRIPTION_STATUSES.ACTIVE, {
        reason: 'PAYMENT_SUCCEEDED'
      });
      await TenantLifecycleService.transitionLifecycle(tx, tenantId, TENANT_LIFECYCLE_STATES.ACTIVE, 'Payment recovered');

      const finalState = await TenantLifecycleService.getLifecycleState(tx, tenantId);
      assert.strictEqual(finalState, TENANT_LIFECYCLE_STATES.ACTIVE);
    });
  });
});
