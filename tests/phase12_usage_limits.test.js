const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  EntitlementEngine,
  SubscriptionService,
  LIMITS,
  LIMIT_TYPES,
  BILLING_ERRORS
} = require('../src/billing');

test('Phase 12 — Usage Limits (Hard vs Soft) & Downgrade Violation Handling (INV-12-16, INV-12-25, INV-12-26, Critical Test 63)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Hard limits block operation with PLAN_LIMIT_REACHED (INV-12-25)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // STARTER has MAX_USERS: 2
      await SubscriptionService.createSubscription(tx, {
        tenantId,
        planVersionId: 'STARTER_V1',
        status: 'ACTIVE'
      });

      // Within limit: 1 user
      const check1 = await EntitlementEngine.checkLimit(tx, tenantId, LIMITS.MAX_USERS, 1);
      assert.strictEqual(check1.allowed, true);

      // At limit: 2 users -> HARD limit blocked
      await assert.rejects(
        async () => EntitlementEngine.checkLimit(tx, tenantId, LIMITS.MAX_USERS, 2),
        (err) => {
          assert.strictEqual(err.code, BILLING_ERRORS.PLAN_LIMIT_REACHED);
          assert.strictEqual(err.limit, 2);
          return true;
        }
      );
    });
  });

  await t.test('2. Soft limits allow operation with warning (INV-12-26)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Create version with soft limit on MAX_API_REQUESTS
      const sub = (await tx.query('subscriptions', s => s.tenant_id === tenantId))[0];
      const checkSoft = await EntitlementEngine.checkLimit(tx, tenantId, LIMITS.MAX_API_REQUESTS, 1000);

      // Soft limits do not block; they notify
      assert.strictEqual(checkSoft.allowed, true);
      assert.strictEqual(checkSoft.limitType, LIMIT_TYPES.SOFT);
    });
  });

  await t.test('3. Critical Test 63: Downgrade with limit violation preserves data and flags violation (INV-12-16)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Upgrade to BUSINESS_V1 (allows 20 users)
      const subs = await tx.query('subscriptions', s => s.tenant_id === tenantId);
      const sub = subs[0];

      await SubscriptionService.changePlan(tx, {
        subscriptionId: sub.id,
        newPlanVersionId: 'BUSINESS_V1',
        reason: 'Upgrade to Business'
      });

      // Create 5 boutique team users
      for (let i = 1; i <= 5; i++) {
        await tx.insert('users', {
          id: generateUUIDv7(),
          tenant_id: tenantId,
          name: `Team Member ${i}`,
          email: `team${i}@boutique.dz`,
          role: 'SALES_ASSOCIATE'
        });
      }

      const usersBefore = await tx.query('users', u => u.tenant_id === tenantId);
      assert.strictEqual(usersBefore.length, 5);

      // 2. Downgrade to STARTER_V1 (maxUsers: 2) -> creates limit violation
      const downgradeResult = await SubscriptionService.changePlan(tx, {
        subscriptionId: sub.id,
        newPlanVersionId: 'STARTER_V1',
        reason: 'Downgrade to Starter'
      });

      assert.strictEqual(downgradeResult.limitViolated, true);
      assert.strictEqual(downgradeResult.changeRecord.status, 'PLAN_DOWNGRADE_PENDING');

      // 3. Verify users are NOT silently deleted (INV-12-16)
      const usersAfter = await tx.query('users', u => u.tenant_id === tenantId);
      assert.strictEqual(usersAfter.length, 5);

      // 4. Verify subscription flagged with violation status
      const updatedSub = await tx.findById('subscriptions', sub.id);
      assert.strictEqual(updatedSub.violation_status, 'LIMIT_VIOLATION');
    });
  });
});
