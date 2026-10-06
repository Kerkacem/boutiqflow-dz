const test = require('node:test');
const assert = require('node:assert');
const {
  AbusePreventionEngine,
  RATE_LIMIT_SCOPES
} = require('../src/billing');

test('Phase 12 — Abuse & Category Rate Limits (INV-12-12, Requirement 46)', async (t) => {
  AbusePreventionEngine.resetRateLimits();

  await t.test('1. Enforces sliding window rate limits and calculates retryAfterMs (INV-12-12)', async () => {
    const key = 'auth:signup:ip_192.168.1.1';
    const maxLimit = 5;
    const windowMs = 5000;

    // First 5 requests must succeed
    for (let i = 0; i < 5; i++) {
      const res = AbusePreventionEngine.checkRateLimit(key, maxLimit, windowMs);
      assert.strictEqual(res.allowed, true);
      assert.strictEqual(res.current, i + 1);
    }

    // 6th request exceeds limit
    const blockedRes = AbusePreventionEngine.checkRateLimit(key, maxLimit, windowMs);
    assert.strictEqual(blockedRes.allowed, false);
    assert.ok(blockedRes.retryAfterMs > 0);
  });

  await t.test('2. Strict separation of rate limit categories (Auth vs Billing vs Abuse vs Business)', async () => {
    AbusePreventionEngine.resetRateLimits();
    const tenantId = 'tenant_123';

    // Max out Auth limit
    for (let i = 0; i < 3; i++) {
      AbusePreventionEngine.checkRateLimit(`AUTH:${tenantId}`, 3, 10000);
    }
    const authBlocked = AbusePreventionEngine.checkRateLimit(`AUTH:${tenantId}`, 3, 10000);
    assert.strictEqual(authBlocked.allowed, false);

    // Billing limit remains completely independent and available
    const billingAllowed = AbusePreventionEngine.checkRateLimit(`BILLING:${tenantId}`, 5, 10000);
    assert.strictEqual(billingAllowed.allowed, true);

    // Business limit remains completely independent and available
    const businessAllowed = AbusePreventionEngine.checkRateLimit(`BUSINESS:${tenantId}`, 10, 10000);
    assert.strictEqual(businessAllowed.allowed, true);
  });
});
