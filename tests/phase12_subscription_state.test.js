const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  SubscriptionService,
  SUBSCRIPTION_STATUSES,
  BILLING_ERRORS
} = require('../src/billing');

test('Phase 12 — Subscription State Machine & Proration (INV-12-09, Requirement 29)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Valid explicit state transitions through lifecycle (INV-12-09)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const sub = await SubscriptionService.createSubscription(tx, {
        tenantId,
        planVersionId: 'STARTER_V1',
        status: SUBSCRIPTION_STATUSES.TRIALING
      });
      assert.strictEqual(sub.status, SUBSCRIPTION_STATUSES.TRIALING);

      // TRIALING -> ACTIVE
      const active = await SubscriptionService.transitionStatus(tx, sub.id, SUBSCRIPTION_STATUSES.ACTIVE, { reason: 'TRIAL_CONVERTED' });
      assert.strictEqual(active.status, SUBSCRIPTION_STATUSES.ACTIVE);

      // ACTIVE -> PAST_DUE
      const pastDue = await SubscriptionService.transitionStatus(tx, sub.id, SUBSCRIPTION_STATUSES.PAST_DUE, { reason: 'PAYMENT_FAILED' });
      assert.strictEqual(pastDue.status, SUBSCRIPTION_STATUSES.PAST_DUE);

      // PAST_DUE -> SUSPENDED
      const suspended = await SubscriptionService.transitionStatus(tx, sub.id, SUBSCRIPTION_STATUSES.SUSPENDED, { reason: 'GRACE_EXPIRED' });
      assert.strictEqual(suspended.status, SUBSCRIPTION_STATUSES.SUSPENDED);
    });
  });

  await t.test('2. Prohibit SUSPENDED -> ACTIVE without validated payment reactivation flow (INV-12-09)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const subs = await tx.query('subscriptions', s => s.tenant_id === tenantId);
      const sub = subs[0];

      // Arbitrary / frontend claim to reactivate must fail
      await assert.rejects(
        async () => SubscriptionService.transitionStatus(tx, sub.id, SUBSCRIPTION_STATUSES.ACTIVE, {
          reason: 'USER_CLICKED_REACTIVATE'
        }),
        (err) => {
          assert.strictEqual(err.code, BILLING_ERRORS.INVALID_STATE_TRANSITION);
          return true;
        }
      );

      // Formal PAYMENT_SUCCEEDED reactivation succeeds
      const reactivated = await SubscriptionService.transitionStatus(tx, sub.id, SUBSCRIPTION_STATUSES.ACTIVE, {
        reason: 'PAYMENT_SUCCEEDED'
      });
      assert.strictEqual(reactivated.status, SUBSCRIPTION_STATUSES.ACTIVE);
    });
  });

  await t.test('3. Deterministic Proration calculation across policies (Requirement 29)', async () => {
    const start = '2026-01-01T00:00:00Z';
    const end = '2026-01-31T00:00:00Z'; // 30 days
    const changeDate = '2026-01-16T00:00:00Z'; // 15 days remaining

    // DAILY policy: 1490 -> 2990 (diff 1500), 15/30 = 50% -> 750
    const daily = SubscriptionService.calculateProration({
      currentPrice: 1490,
      newPrice: 2990,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      changeDate,
      policy: 'DAILY'
    });
    assert.strictEqual(daily.proratedAmount, 750);
    assert.strictEqual(daily.policy, 'DAILY');

    // NONE policy
    const none = SubscriptionService.calculateProration({
      currentPrice: 1490,
      newPrice: 2990,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      changeDate,
      policy: 'NONE'
    });
    assert.strictEqual(none.proratedAmount, 0);

    // NEXT_CYCLE policy
    const nextCycle = SubscriptionService.calculateProration({
      currentPrice: 1490,
      newPrice: 2990,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      changeDate,
      policy: 'NEXT_CYCLE'
    });
    assert.strictEqual(nextCycle.proratedAmount, 0);
    assert.strictEqual(nextCycle.effectiveNextCycle, true);
  });
});
