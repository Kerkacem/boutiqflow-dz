const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  EntitlementEngine,
  SubscriptionService,
  SUBSCRIPTION_STATUSES,
  FEATURES
} = require('../src/billing');

test('Phase 12 — Entitlement Cache & Immediate Invalidation (INV-12-22)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Entitlement caching and immediate invalidation on subscription status change (INV-12-22)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Create ACTIVE subscription on PRO_V1
      const sub = await SubscriptionService.createSubscription(tx, {
        tenantId,
        planVersionId: 'PRO_V1',
        status: SUBSCRIPTION_STATUSES.ACTIVE
      });

      // 2. Query entitlement (populates cache)
      const hasReports1 = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_REPORTS_ADVANCED);
      assert.strictEqual(hasReports1, true);

      // Verify cached value returned quickly
      const hasReportsCached = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_REPORTS_ADVANCED);
      assert.strictEqual(hasReportsCached, true);

      // 3. Suspend subscription
      await SubscriptionService.transitionStatus(tx, sub.id, SUBSCRIPTION_STATUSES.SUSPENDED, {
        reason: 'NON_PAYMENT'
      });

      // 4. Query again: cache MUST be invalidated, immediately returning false
      const hasReportsAfterSuspend = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_REPORTS_ADVANCED);
      assert.strictEqual(hasReportsAfterSuspend, false);
    });
  });

  await t.test('2. Entitlement cache invalidation on plan upgrade (INV-12-22)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Reactivate on STARTER_V1
      const sub = (await tx.query('subscriptions', s => s.tenant_id === tenantId))[0];
      await SubscriptionService.transitionStatus(tx, sub.id, SUBSCRIPTION_STATUSES.ACTIVE, {
        reason: 'PAYMENT_SUCCEEDED'
      });
      await SubscriptionService.changePlan(tx, {
        subscriptionId: sub.id,
        newPlanVersionId: 'STARTER_V1',
        reason: 'Reset to Starter'
      });

      // STARTER does NOT have API feature
      const hasApi1 = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_API);
      assert.strictEqual(hasApi1, false);

      // Upgrade to BUSINESS_V1
      await SubscriptionService.changePlan(tx, {
        subscriptionId: sub.id,
        newPlanVersionId: 'BUSINESS_V1',
        reason: 'Upgrade to Business'
      });

      // Cache MUST be invalidated immediately; FEATURE_API now true
      const hasApiAfterUpgrade = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_API);
      assert.strictEqual(hasApiAfterUpgrade, true);
    });
  });
});
