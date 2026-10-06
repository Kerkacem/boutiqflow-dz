const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  PlanService,
  EntitlementEngine,
  SubscriptionService,
  PLANS,
  FEATURES,
  SUBSCRIPTION_STATUSES
} = require('../src/billing');

test('Phase 12 — Plan Model, Versioning & Entitlements (INV-12-01, INV-12-02, INV-12-03, Critical Test 59)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Plan versions preserve historical pricing when new versions are created (INV-12-03)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const v1 = await PlanService.getPlanVersion(tx, 'STARTER_V1');
      assert.strictEqual(v1.price_amount, 1490);
      assert.strictEqual(v1.currency, 'DZD');

      // Create v2 with new price
      const v2 = await PlanService.createPlanVersion(tx, {
        planId: PLANS.STARTER,
        version: 'v2',
        priceAmount: 1890,
        currency: 'DZD',
        billingInterval: 'MONTHLY',
        features: v1.features,
        limits: v1.limits
      });
      assert.strictEqual(v2.price_amount, 1890);

      // Verify v1 historical price remained unchanged
      const v1Again = await PlanService.getPlanVersion(tx, 'STARTER_V1');
      assert.strictEqual(v1Again.price_amount, 1490);
    });
  });

  await t.test('2. Server-side EntitlementEngine evaluates feature access authoritatively (INV-12-01, INV-12-02)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Create a subscription on STARTER_V1
      await SubscriptionService.createSubscription(tx, {
        tenantId,
        planVersionId: 'STARTER_V1',
        status: SUBSCRIPTION_STATUSES.ACTIVE
      });

      // STARTER has FEATURE_POS, but NOT FEATURE_API or FEATURE_SHOPIFY
      const hasPOS = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_POS);
      assert.strictEqual(hasPOS, true);

      const hasAPI = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_API);
      assert.strictEqual(hasAPI, false);

      const hasShopify = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_SHOPIFY);
      assert.strictEqual(hasShopify, false);
    });
  });

  await t.test('3. Critical Test 59: Client claims plan=BUSINESS when subscription=STARTER -> PLAN_FORGED', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Evaluate with client claiming BUSINESS
      await assert.rejects(
        async () => EntitlementEngine.evaluateClientClaim(tx, tenantId, {
          claimedPlanCode: PLANS.BUSINESS,
          featureCode: FEATURES.FEATURE_API
        }),
        (err) => {
          assert.strictEqual(err.code, 'PLAN_FORGED');
          return true;
        }
      );

      // Verify feature access remains denied
      const hasAPI = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_API);
      assert.strictEqual(hasAPI, false);
    });
  });
});
