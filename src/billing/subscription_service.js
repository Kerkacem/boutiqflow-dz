/**
 * BoutiqFlow DZ — Subscription Service & Lifecycle Transitions (INV-12-09, INV-12-14, INV-12-16)
 * Manages subscription state machines, plan upgrades, downgrades without silent data loss,
 * and deterministic proration policies (Requirement 29).
 */

const { generateUUIDv7 } = require('../db/utils');
const {
  SUBSCRIPTION_STATUSES,
  BILLING_ERRORS,
  LIMITS
} = require('./constants');
const { PlanService } = require('./plan_service');
const { EntitlementEngine } = require('./entitlement_engine');

class SubscriptionService {
  /**
   * Calculates deterministic proration for plan changes (Requirement 29)
   */
  static calculateProration({
    currentPrice,
    newPrice,
    currentPeriodStart,
    currentPeriodEnd,
    changeDate = new Date(),
    policy = 'DAILY'
  }) {
    if (policy === 'NONE') {
      return { proratedAmount: 0, policy: 'NONE' };
    }
    if (policy === 'NEXT_CYCLE') {
      return { proratedAmount: 0, effectiveNextCycle: true, policy: 'NEXT_CYCLE' };
    }

    // DAILY policy
    const startMs = new Date(currentPeriodStart).getTime();
    const endMs = new Date(currentPeriodEnd).getTime();
    const changeMs = new Date(changeDate).getTime();

    const totalDurationMs = Math.max(1, endMs - startMs);
    const remainingDurationMs = Math.max(0, Math.min(totalDurationMs, endMs - changeMs));

    const totalDays = Math.ceil(totalDurationMs / (24 * 3600 * 1000));
    const remainingDays = Math.ceil(remainingDurationMs / (24 * 3600 * 1000));

    const priceDiff = Number(newPrice) - Number(currentPrice);
    const proratedAmount = Math.round((priceDiff * remainingDays) / totalDays);

    return {
      proratedAmount,
      totalDays,
      remainingDays,
      policy: 'DAILY'
    };
  }

  /**
   * Creates a subscription record
   */
  static async createSubscription(tx, {
    tenantId,
    planVersionId = 'STARTER_V1',
    planId = 'STARTER',
    status = SUBSCRIPTION_STATUSES.TRIALING,
    trialEndsAt = null
  }) {
    const subId = generateUUIDv7();
    const now = new Date();
    const effectiveTrialEnd = trialEndsAt || new Date(now.getTime() + 14 * 24 * 3600 * 1000).toISOString();

    const record = {
      id: subId,
      tenant_id: tenantId,
      plan_version_id: planVersionId,
      plan_id: planId,
      status,
      trial_ends_at: effectiveTrialEnd,
      current_period_start: now.toISOString(),
      current_period_end: new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString(),
      grace_ends_at: null,
      violation_status: 'NONE',
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    };

    await tx.insert('subscriptions', record);
    EntitlementEngine.invalidateTenantCache(tenantId);
    return record;
  }

  /**
   * Transitions subscription status according to explicit state machine rules (INV-12-09)
   */
  static async transitionStatus(tx, subscriptionId, targetStatus, { reason = '', actorId = null } = {}) {
    const sub = await tx.findById('subscriptions', subscriptionId);
    if (!sub) throw new Error(`Subscription ${subscriptionId} not found`);

    const currentStatus = sub.status;

    // Reject direct activation from SUSPENDED or CANCELLED without formal payment reactivation flow
    if ((currentStatus === SUBSCRIPTION_STATUSES.SUSPENDED || currentStatus === SUBSCRIPTION_STATUSES.CANCELLED) && targetStatus === SUBSCRIPTION_STATUSES.ACTIVE) {
      if (reason !== 'PAYMENT_SUCCEEDED' && reason !== 'ADMIN_OVERRIDE') {
        const err = new Error(`Invalid State Transition: Cannot transition from ${currentStatus} to ${targetStatus} without validated payment or admin override (INV-12-09)`);
        err.code = BILLING_ERRORS.INVALID_STATE_TRANSITION;
        throw err;
      }
    }

    const updated = await tx.update('subscriptions', sub.id, {
      status: targetStatus,
      updated_at: new Date().toISOString()
    });

    // Invalidate cache immediately on status change (INV-12-22)
    EntitlementEngine.invalidateTenantCache(sub.tenant_id);

    await tx.insert('audit_logs', {
      action: 'SUBSCRIPTION_STATUS_CHANGED',
      actor_id: actorId || tx.session?.userId || 'system',
      entity_type: 'subscription',
      entity_id: sub.id,
      details: { previousStatus: currentStatus, targetStatus, reason },
      created_at: new Date().toISOString()
    });

    return updated;
  }

  /**
   * Upgrades or downgrades subscription plan version (INV-12-16, Critical Test 63)
   */
  static async changePlan(tx, {
    subscriptionId,
    newPlanVersionId,
    reason = 'PLAN_CHANGE',
    actorId = null
  }) {
    const sub = await tx.findById('subscriptions', subscriptionId);
    if (!sub) throw new Error(`Subscription ${subscriptionId} not found`);

    const newVersion = await PlanService.getPlanVersion(tx, newPlanVersionId);
    if (!newVersion) throw new Error(`Plan version ${newPlanVersionId} not found`);

    const tenantId = sub.tenant_id;
    const oldPlanVersionId = sub.plan_version_id;

    // Check usage against new limits to detect downgrade violations (INV-12-16)
    const users = await tx.query('users', u => u.tenant_id === tenantId);
    const userLimit = newVersion.limits[LIMITS.MAX_USERS] || Infinity;
    const isLimitViolated = users.length > userLimit;

    const changeRecordId = generateUUIDv7();
    const changeRecord = {
      id: changeRecordId,
      tenant_id: tenantId,
      subscription_id: sub.id,
      old_plan_version_id: oldPlanVersionId,
      new_plan_version_id: newPlanVersionId,
      reason,
      status: isLimitViolated ? 'PLAN_DOWNGRADE_PENDING' : 'APPLIED',
      limit_violation: isLimitViolated ? { limit: LIMITS.MAX_USERS, max: userLimit, actual: users.length } : null,
      created_at: new Date().toISOString()
    };

    await tx.insert('subscription_changes', changeRecord);

    // Apply change to subscription without deleting any users/products (INV-12-16)
    const updatedSub = await tx.update('subscriptions', sub.id, {
      plan_version_id: newPlanVersionId,
      plan_id: newVersion.plan_id,
      violation_status: isLimitViolated ? 'LIMIT_VIOLATION' : 'NONE',
      updated_at: new Date().toISOString()
    });

    // Invalidate cache immediately (INV-12-22)
    EntitlementEngine.invalidateTenantCache(tenantId);

    return {
      subscription: updatedSub,
      changeRecord,
      limitViolated: isLimitViolated
    };
  }

  /**
   * Asserts that operational mutations (sales, orders, etc.) are allowed by subscription state (INV-12-14)
   */
  static assertMutationAllowed(subscription) {
    if (!subscription) return;

    if (subscription.status === SUBSCRIPTION_STATUSES.SUSPENDED) {
      const err = new Error('Subscription Suspended: Account cannot perform mutations (INV-12-14)');
      err.code = BILLING_ERRORS.SUBSCRIPTION_SUSPENDED;
      err.statusCode = 403;
      throw err;
    }

    if (subscription.status === SUBSCRIPTION_STATUSES.READ_ONLY) {
      const err = new Error('Subscription Read-Only: Account in read-only mode, mutations blocked (INV-12-14)');
      err.code = BILLING_ERRORS.SUBSCRIPTION_READ_ONLY;
      err.statusCode = 403;
      throw err;
    }
  }
}

module.exports = {
  SubscriptionService
};
