/**
 * BoutiqFlow DZ — Abuse Prevention & Rate Limiting Engine (INV-12-12, INV-12-13)
 * Evaluates risk signals (velocity, OTP abuse, trial reuse) without excessive fingerprinting.
 * High risk triggers challenges or reviews rather than automated unilateral bans.
 */

const { generateUUIDv7 } = require('../db/utils');
const { ABUSE_SIGNALS, ABUSE_DECISIONS } = require('./constants');

// Rate limiting in-memory sliding window counters
const rateLimitBuckets = new Map();

class AbusePreventionEngine {
  /**
   * Enforces scoped sliding-window rate limits (INV-12-12)
   */
  static checkRateLimit(key, maxLimit, windowMs = 60000) {
    const now = Date.now();
    let bucket = rateLimitBuckets.get(key);

    if (!bucket) {
      bucket = { timestamps: [] };
      rateLimitBuckets.set(key, bucket);
    }

    // Filter out timestamps outside window
    bucket.timestamps = bucket.timestamps.filter(ts => (now - ts) < windowMs);

    if (bucket.timestamps.length >= maxLimit) {
      return {
        allowed: false,
        limit: maxLimit,
        current: bucket.timestamps.length,
        retryAfterMs: windowMs - (now - bucket.timestamps[0])
      };
    }

    bucket.timestamps.push(now);
    return {
      allowed: true,
      limit: maxLimit,
      current: bucket.timestamps.length
    };
  }

  /**
   * Resets rate limit bucket (for testing)
   */
  static resetRateLimits() {
    rateLimitBuckets.clear();
  }

  /**
   * Evaluates an abuse signal with contextual decision thresholds (INV-12-13)
   */
  static async recordAndEvaluateSignal(tx, {
    tenantId,
    signalType,
    confidence = 'MEDIUM',
    metadata = {}
  }) {
    const signalId = generateUUIDv7();
    const signalRecord = {
      id: signalId,
      tenant_id: tenantId,
      signal_type: signalType,
      confidence,
      metadata,
      created_at: new Date().toISOString()
    };

    await tx.insert('abuse_signals', signalRecord);

    // Fetch recent signals for this tenant
    const recentSignals = await tx.query('abuse_signals', s => s.tenant_id === tenantId);

    // Decision Logic: Single signal != ban (INV-12-13)
    let decision = ABUSE_DECISIONS.ALLOW;
    let reason = 'Signal within normal risk tolerance';

    if (recentSignals.length >= 5) {
      decision = ABUSE_DECISIONS.REVIEW;
      reason = 'High signal density requires compliance review';
    } else if (recentSignals.length >= 3) {
      decision = ABUSE_DECISIONS.CHALLENGE;
      reason = 'Moderate risk velocity warrants step-up OTP challenge';
    } else if (confidence === 'HIGH') {
      decision = ABUSE_DECISIONS.LIMIT;
      reason = 'High confidence isolated risk signal limits trial velocity';
    }

    const decisionRecord = {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      decision,
      reason,
      applied_at: new Date().toISOString()
    };

    await tx.insert('abuse_decisions', decisionRecord);

    return {
      decision,
      reason,
      signalCount: recentSignals.length
    };
  }
}

module.exports = {
  AbusePreventionEngine
};
