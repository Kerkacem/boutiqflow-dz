const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  AdminOverrideService,
  EntitlementEngine,
  SubscriptionService,
  FEATURES,
  SUBSCRIPTION_STATUSES
} = require('../src/billing');

test('Phase 12 — Admin Overrides & Comp Access Controls (INV-12-18)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Prohibit admin override without documented business reason and actor (INV-12-18)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Missing reason
      await assert.rejects(
        async () => AdminOverrideService.createOverride(tx, {
          tenantId,
          featureCode: FEATURES.FEATURE_API,
          actor: 'saas_admin@boutiqflow.dz',
          reason: ''
        }),
        (err) => {
          assert.strictEqual(err.code, 'REASON_REQUIRED');
          return true;
        }
      );

      // Missing actor
      await assert.rejects(
        async () => AdminOverrideService.createOverride(tx, {
          tenantId,
          featureCode: FEATURES.FEATURE_API,
          reason: 'Promotional grant for testing',
          actor: ''
        }),
        (err) => {
          assert.strictEqual(err.code, 'ACTOR_REQUIRED');
          return true;
        }
      );
    });
  });

  await t.test('2. Comp grant provides feature access with audit trail and cache invalidation (INV-12-18)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Create subscription on STARTER_V1 (no FEATURE_API)
      await SubscriptionService.createSubscription(tx, {
        tenantId,
        planVersionId: 'STARTER_V1',
        status: SUBSCRIPTION_STATUSES.ACTIVE
      });

      const beforeOverride = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_API);
      assert.strictEqual(beforeOverride, false);

      // Grant 30-day COMP access to FEATURE_API
      const override = await AdminOverrideService.createOverride(tx, {
        tenantId,
        featureCode: FEATURES.FEATURE_API,
        type: 'COMP',
        reason: 'VIP Retailer Pilot Program - Oran Launch',
        actor: 'superadmin_1',
        ticketReference: 'SUPPORT-9842',
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString()
      });
      assert.ok(override.id);

      // Query entitlement: now true!
      const afterOverride = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_API);
      assert.strictEqual(afterOverride, true);

      // Verify audit log exists
      const audit = await tx.query('audit_logs', a =>
        a.tenant_id === tenantId && a.action === 'ADMIN_OVERRIDE_CREATED'
      );
      assert.strictEqual(audit.length, 1);
      assert.strictEqual(audit[0].details.ticketReference, 'SUPPORT-9842');

      // Revoke override
      await AdminOverrideService.revokeOverride(tx, {
        overrideId: override.id,
        actor: 'superadmin_1',
        reason: 'Pilot concluded early'
      });

      // Entitlement immediately false again
      const afterRevoke = await EntitlementEngine.hasEntitlement(tx, tenantId, FEATURES.FEATURE_API);
      assert.strictEqual(afterRevoke, false);
    });
  });
});
