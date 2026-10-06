/**
 * BoutiqFlow DZ — Entitlement Engine & Server-Side Enforcement (INV-12-01, INV-12-02, INV-12-22, INV-12-25, INV-12-26)
 * Authoritatively evaluates feature access and hard/soft limits based on database
 * subscription state, plan versions, and admin overrides, ignoring client claims.
 */

const {
  FEATURES,
  LIMITS,
  LIMIT_TYPES,
  LIMIT_DEFINITIONS,
  SUBSCRIPTION_STATUSES,
  BILLING_ERRORS
} = require('./constants');
const { PlanService } = require('./plan_service');

// Short-lived in-memory cache with immediate invalidation support (INV-12-22)
const entitlementCache = new Map();
const CACHE_TTL_MS = 60000; // 1 minute max

class EntitlementEngine {
  /**
   * Invalidates cached entitlements for a tenant immediately (INV-12-22)
   */
  static invalidateTenantCache(tenantId) {
    for (const key of entitlementCache.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        entitlementCache.delete(key);
      }
    }
  }

  static invalidateCache(tenantId) {
    this.invalidateTenantCache(tenantId);
  }

  /**
   * Clears the entire entitlement cache (for testing/maintenance)
   */
  static clearCache() {
    entitlementCache.clear();
  }

  /**
   * Evaluates client plan claim vs authoritative subscription (Critical Test 59)
   */
  static async evaluateClientClaim(tx, tenantId, { claimedPlanCode, featureCode }) {
    return this.hasEntitlement(tx, tenantId, featureCode, { clientClaimedPlan: claimedPlanCode });
  }

  /**
   * Checks whether a tenant is entitled to a specific feature (INV-12-01, INV-12-02)
   */
  static async hasEntitlement(tx, tenantId, featureCode, { clientClaimedPlan = null } = {}) {
    // Critical Test 59: Reject forged client plan claims (INV-12-01)
    // Server derives state strictly from database subscription
    const cacheKey = `${tenantId}:${featureCode}`;
    const cached = entitlementCache.get(cacheKey);
    const now = Date.now();

    if (cached && (now - cached.cachedAt) < CACHE_TTL_MS && !clientClaimedPlan) {
      return cached.entitled;
    }

    // 1. Check for active Admin Comp / Override (INV-12-18)
    const overrides = await tx.query('entitlement_overrides', o =>
      o.tenant_id === tenantId && o.feature_code === featureCode && !o.revoked_at && !o.revoked_by
    );

    const activeOverride = overrides.find(o => {
      const start = new Date(o.starts_at).getTime();
      const end = o.expires_at ? new Date(o.expires_at).getTime() : Infinity;
      return now >= start && now < end;
    });

    if (activeOverride) {
      entitlementCache.set(cacheKey, { entitled: Boolean(activeOverride.override_value), cachedAt: now });
      return Boolean(activeOverride.override_value);
    }

    // 2. Fetch authoritative subscription from database
    const subs = await tx.query('subscriptions', s => s.tenant_id === tenantId);
    if (subs.length === 0) {
      return false;
    }

    const sub = subs[0];

    // 3. Subscription Status Check
    if (sub.status === SUBSCRIPTION_STATUSES.SUSPENDED || sub.status === SUBSCRIPTION_STATUSES.EXPIRED || sub.status === SUBSCRIPTION_STATUSES.CANCELLED) {
      entitlementCache.set(cacheKey, { entitled: false, cachedAt: now });
      return false;
    }

    if (sub.status === SUBSCRIPTION_STATUSES.READ_ONLY) {
      // In READ_ONLY, only export and read features are permitted; mutations are blocked
      const readOnlyAllowed = [FEATURES.FEATURE_EXPORT, FEATURES.FEATURE_REPORTS_ADVANCED];
      const isAllowed = readOnlyAllowed.includes(featureCode);
      entitlementCache.set(cacheKey, { entitled: isAllowed, cachedAt: now });
      return isAllowed;
    }

    // 4. Resolve Plan Version (INV-12-03)
    let planVersion = null;
    if (sub.plan_version_id) {
      planVersion = await PlanService.getPlanVersion(tx, sub.plan_version_id);
    }
    if (!planVersion && sub.plan_id) {
      planVersion = await PlanService.getLatestPlanVersion(tx, sub.plan_id);
    }

    if (!planVersion) {
      return false;
    }

    // Forged plan detection check: If client sends plan=BUSINESS but sub is STARTER
    if (clientClaimedPlan && clientClaimedPlan.toUpperCase() !== planVersion.plan_id.toUpperCase()) {
      const err = new Error(`Security Violation: Client claimed plan '${clientClaimedPlan}' does not match authoritative subscription plan '${planVersion.plan_id}' (INV-12-01)`);
      err.code = BILLING_ERRORS.PLAN_FORGED;
      err.statusCode = 403;
      throw err;
    }

    const isEntitled = (planVersion.features || []).includes(featureCode);
    entitlementCache.set(cacheKey, { entitled: isEntitled, cachedAt: now });
    return isEntitled;
  }

  /**
   * Evaluates usage limits against authoritative plan boundaries (INV-12-25, INV-12-26)
   */
  static async checkLimit(tx, tenantId, limitCode, currentCount) {
    const subs = await tx.query('subscriptions', s => s.tenant_id === tenantId);
    if (subs.length === 0) {
      throw new Error(`Tenant ${tenantId} has no active subscription`);
    }

    const sub = subs[0];
    let planVersion = null;
    if (sub.plan_version_id) {
      planVersion = await PlanService.getPlanVersion(tx, sub.plan_version_id);
    }
    if (!planVersion && sub.plan_id) {
      planVersion = await PlanService.getLatestPlanVersion(tx, sub.plan_id);
    }

    const limits = planVersion?.limits || {};
    const maxAllowed = limits[limitCode] !== undefined ? limits[limitCode] : Infinity;
    const limitType = LIMIT_DEFINITIONS[limitCode] || LIMIT_TYPES.HARD;

    if (currentCount >= maxAllowed) {
      if (limitType === LIMIT_TYPES.HARD) {
        const err = new Error(`Plan Limit Exceeded: Limit '${limitCode}' reached maximum allowed count (${maxAllowed}) on current plan (INV-12-25)`);
        err.code = BILLING_ERRORS.PLAN_LIMIT_REACHED;
        err.statusCode = 403;
        err.limit = maxAllowed;
        err.currentCount = currentCount;
        throw err;
      } else {
        // Soft limit: Allow with warning (INV-12-26)
        return {
          allowed: true,
          limitType: LIMIT_TYPES.SOFT,
          warning: 'APPROACHING_OR_EXCEEDED_LIMIT',
          limit: maxAllowed,
          currentCount
        };
      }
    }

    return {
      allowed: true,
      limitType,
      limit: maxAllowed,
      currentCount
    };
  }
}

module.exports = {
  EntitlementEngine
};
