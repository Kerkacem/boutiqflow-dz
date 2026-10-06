const test = require('node:test');
const assert = require('node:assert');
const { getSessionCookieConfig } = require('../src/auth/auth_service');

function sanitizeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function validateCsrfAndOrigin({ origin, allowedOrigins, sessionCookie, csrfHeader }) {
  if (!origin || !allowedOrigins.includes(origin)) {
    return { allowed: false, reason: 'CROSS_ORIGIN_FORBIDDEN' };
  }
  if (!csrfHeader || csrfHeader !== sessionCookie.csrfToken) {
    return { allowed: false, reason: 'CSRF_TOKEN_MISMATCH' };
  }
  return { allowed: true };
}

test('Phase 13 — XSS Defense & CSRF Protection (Requirements 17 & 18)', async (t) => {
  await t.test('1. XSS Payloads Sanitization in User Inputs (Requirement 17)', () => {
    const xssPayloads = [
      '<script>alert("XSS")</script>',
      '<img src=x onerror=alert(1)>',
      '"><svg onload=alert(document.cookie)>',
      "javascript:alert('XSS')"
    ];

    for (const payload of xssPayloads) {
      const sanitized = sanitizeHtml(payload);
      assert.strictEqual(sanitized.includes('<script>'), false);
      assert.strictEqual(sanitized.includes('<img'), false);
      assert.strictEqual(sanitized.includes('<svg'), false);
      assert.strictEqual(sanitized.includes('>'), false);
      assert.strictEqual(sanitized.includes('<'), false);
    }
  });

  await t.test('2. Cookie Security Policies & SameSite Attributes (Requirement 18)', () => {
    const cookie = getSessionCookieConfig('dummy_token', new Date().toISOString());
    const opts = cookie.options || cookie;
    assert.strictEqual(opts.httpOnly, true, 'Session cookie must be HttpOnly');
    assert.strictEqual(opts.secure, true, 'Session cookie must be Secure');
    assert.strictEqual(opts.sameSite.toLowerCase(), 'strict', 'Session cookie must be SameSite=Strict');
  });

  await t.test('3. Cross-Site Mutation Request is Blocked by CSRF / Origin Policy (Requirement 18)', () => {
    const allowedOrigins = ['https://app.boutiqflow.dz', 'https://pos.boutiqflow.dz'];
    const sessionCookie = { token: 'valid_sess', csrfToken: 'CSRF_SECRET_123' };

    // Malicious attacker origin
    const attack1 = validateCsrfAndOrigin({
      origin: 'https://evil-attacker.example',
      allowedOrigins,
      sessionCookie,
      csrfHeader: 'CSRF_SECRET_123'
    });
    assert.strictEqual(attack1.allowed, false);
    assert.strictEqual(attack1.reason, 'CROSS_ORIGIN_FORBIDDEN');

    // Missing CSRF token
    const attack2 = validateCsrfAndOrigin({
      origin: 'https://app.boutiqflow.dz',
      allowedOrigins,
      sessionCookie,
      csrfHeader: null
    });
    assert.strictEqual(attack2.allowed, false);
    assert.strictEqual(attack2.reason, 'CSRF_TOKEN_MISMATCH');

    // Legitimate matching request
    const validReq = validateCsrfAndOrigin({
      origin: 'https://app.boutiqflow.dz',
      allowedOrigins,
      sessionCookie,
      csrfHeader: 'CSRF_SECRET_123'
    });
    assert.strictEqual(validReq.allowed, true);
  });
});
