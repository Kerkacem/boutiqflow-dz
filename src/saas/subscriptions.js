/**
 * SaaS Subscription State Machine & Entitlements Engine
 * States:
 * - TRIALING (14-day full access)
 * - ACTIVE (paid subscription)
 * - PAST_DUE (7-day grace period: full access with banner)
 * - READ_ONLY (grace period expired: view & export allowed, mutations blocked)
 * - SUSPENDED
 * Non-negotiable: NEVER delete tenant data upon non-payment.
 */

const SUBSCRIPTION_STATUS = {
  TRIALING: 'TRIALING',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  READ_ONLY: 'READ_ONLY',
  SUSPENDED: 'SUSPENDED'
};

async function evaluateSubscriptionStatus(subscription) {
  const now = new Date();
  const trialEnd = new Date(subscription.trial_ends_at);
  const periodEnd = subscription.current_period_ends_at ? new Date(subscription.current_period_ends_at) : null;
  const graceEnd = subscription.grace_period_ends_at ? new Date(subscription.grace_period_ends_at) : null;

  if (subscription.status === SUBSCRIPTION_STATUS.TRIALING) {
    if (now > trialEnd) {
      // 14 days trial expired -> Enter 7-day grace period (PAST_DUE)
      return SUBSCRIPTION_STATUS.PAST_DUE;
    }
    return SUBSCRIPTION_STATUS.TRIALING;
  }

  if (subscription.status === SUBSCRIPTION_STATUS.ACTIVE) {
    if (periodEnd && now > periodEnd) {
      return SUBSCRIPTION_STATUS.PAST_DUE;
    }
    return SUBSCRIPTION_STATUS.ACTIVE;
  }

  if (subscription.status === SUBSCRIPTION_STATUS.PAST_DUE) {
    if (graceEnd && now > graceEnd) {
      // Grace period expired -> Enter READ_ONLY mode
      return SUBSCRIPTION_STATUS.READ_ONLY;
    }
    return SUBSCRIPTION_STATUS.PAST_DUE;
  }

  return subscription.status;
}

/**
 * Gatekeeper enforcing mutation restrictions in READ_ONLY mode (UAT-14)
 */
function assertMutationAllowed(subscription) {
  if (subscription.status === SUBSCRIPTION_STATUS.READ_ONLY) {
    const error = new Error('Subscription Expired: Account is in read-only mode. Data modification blocked.');
    error.statusCode = 403;
    error.code = 'SUBSCRIPTION_READ_ONLY';
    throw error;
  }
  if (subscription.status === SUBSCRIPTION_STATUS.SUSPENDED) {
    const error = new Error('Account Suspended: Contact support.');
    error.statusCode = 403;
    error.code = 'ACCOUNT_SUSPENDED';
    throw error;
  }
}

/**
 * Validates plan entitlements (users, locations, variants)
 */
async function checkEntitlements(tx, subscription, resourceType) {
  const plan = tx.db.tables.plans.get(subscription.plan_id);
  if (!plan) throw new Error(`Plan ${subscription.plan_id} not found`);

  if (resourceType === 'users') {
    const users = await tx.query('users');
    if (users.length >= plan.max_users) {
      throw new Error(`Plan limit reached: Maximum ${plan.max_users} users allowed on ${plan.name}`);
    }
  } else if (resourceType === 'locations') {
    const locations = await tx.query('inventory_locations');
    if (locations.length >= plan.max_locations) {
      throw new Error(`Plan limit reached: Maximum ${plan.max_locations} locations allowed on ${plan.name}`);
    }
  }
}

/**
 * Activates or extends subscription upon payment approval
 */
async function activateSubscription(tx, { subscriptionId, monthsCount = 1 }) {
  const sub = await tx.findById('subscriptions', subscriptionId);
  if (!sub) throw new Error('Subscription not found');

  const currentEnd = sub.current_period_ends_at && new Date(sub.current_period_ends_at) > new Date()
    ? new Date(sub.current_period_ends_at)
    : new Date();

  const newPeriodEnd = new Date(currentEnd.getTime() + monthsCount * 30 * 24 * 3600 * 1000).toISOString();
  const newGraceEnd = new Date(new Date(newPeriodEnd).getTime() + 7 * 24 * 3600 * 1000).toISOString();

  return await tx.update('subscriptions', sub.id, {
    status: SUBSCRIPTION_STATUS.ACTIVE,
    current_period_ends_at: newPeriodEnd,
    grace_period_ends_at: newGraceEnd
  });
}

module.exports = {
  SUBSCRIPTION_STATUS,
  evaluateSubscriptionStatus,
  assertMutationAllowed,
  checkEntitlements,
  activateSubscription
};
