/**
 * BoutiqFlow DZ — Plan & Plan Versioning Service (INV-12-03)
 * Manages commercial tiers and immutable versioned price snapshots
 * so that future price updates never mutate historical billing records.
 */

const { generateUUIDv7 } = require('../db/utils');
const { PLANS, FEATURES, LIMITS } = require('./constants');

class PlanService {
  /**
   * Retrieves plan metadata
   */
  static async getPlan(tx, planCode) {
    return tx.db.tables.plans.get(planCode) || null;
  }

  /**
   * Retrieves a specific versioned plan snapshot
   */
  static async getPlanVersion(tx, planVersionId) {
    return tx.db.tables.plan_versions.get(planVersionId) || null;
  }

  /**
   * Creates a new versioned plan snapshot (INV-12-03)
   */
  static async createPlanVersion(tx, {
    planId,
    version,
    priceAmount,
    priceAmountCents,
    currency = 'DZD',
    billingInterval = 'MONTHLY',
    features = [],
    limits = {},
    status = 'ACTIVE'
  }) {
    if (!planId || !version || (priceAmount === undefined && priceAmountCents === undefined)) {
      throw new Error('Plan version requires planId, version, and priceAmount/priceAmountCents');
    }

    const price = priceAmount !== undefined ? Number(priceAmount) : Math.floor(Number(priceAmountCents) / 100);
    const priceCents = priceAmountCents !== undefined ? BigInt(priceAmountCents) : BigInt(price * 100);

    const versionId = `${planId.toUpperCase()}_${version.toUpperCase()}`;
    const planVersionRecord = {
      id: versionId,
      plan_id: planId.toUpperCase(),
      version: version.toLowerCase(),
      price_amount: price,
      price_amount_cents: priceCents,
      currency: currency.toUpperCase(),
      billing_interval: billingInterval.toUpperCase(),
      features,
      limits,
      status,
      created_at: new Date().toISOString()
    };

    tx.db.tables.plan_versions.set(versionId, planVersionRecord);
    return planVersionRecord;
  }

  /**
   * Retrieves the latest active plan version for a plan code
   */
  static async getLatestPlanVersion(tx, planCode) {
    const code = planCode.toUpperCase();
    const candidate = `${code}_V1`;
    return tx.db.tables.plan_versions.get(candidate) || null;
  }
}

module.exports = {
  PlanService
};
