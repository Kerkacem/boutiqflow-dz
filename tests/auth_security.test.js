const test = require('node:test');
const assert = require('node:assert');
const {
  hashPassword,
  verifyPassword,
  hashToken,
  checkRateLimit,
  recordFailedLogin,
  resetLoginAttempts,
  createSession
} = require('../src/auth/auth_service');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Authentication & Session Security', async (t) => {
  await t.test('Password Hashing with Salt & Verification', () => {
    const rawPass = 'SuperSecretPass123!';
    const hash = hashPassword(rawPass);

    assert.ok(hash.startsWith('pbkdf2:sha512:100000:'), 'Hash must follow format');
    assert.strictEqual(verifyPassword(rawPass, hash), true, 'Correct password must verify');
    assert.strictEqual(verifyPassword('WrongPassword!', hash), false, 'Wrong password must be rejected');

    // Passwords shorter than 8 chars rejected
    assert.throws(() => hashPassword('short'), /at least 8 characters/);
  });

  await t.test('Brute-force Rate Limiting & Backoff', () => {
    const user = 'user@boutique.dz';
    const ip = '197.200.10.5';

    resetLoginAttempts(user, ip);
    assert.strictEqual(checkRateLimit(user, ip).allowed, true);

    // Fail 3 times
    recordFailedLogin(user, ip);
    recordFailedLogin(user, ip);
    recordFailedLogin(user, ip);

    // Now locked
    const check = checkRateLimit(user, ip);
    assert.strictEqual(check.allowed, false, 'Should be locked after 3 failures');
    assert.ok(check.error.includes('Too many login attempts'));

    // Reset allows access
    resetLoginAttempts(user, ip);
    assert.strictEqual(checkRateLimit(user, ip).allowed, true);
  });

  await t.test('Session Creation & Token Hashing at Rest', async () => {
    const db = new MahalDatabase();
    const tenantId = generateUUIDv7();
    const userId = generateUUIDv7();

    await db.withTenant({ tenantId }, async (tx) => {
      const sessionResult = await createSession(tx, {
        tenantId,
        userId,
        ipAddress: '105.100.20.1',
        userAgent: 'Mozilla/5.0 Android'
      });

      assert.ok(sessionResult.token, 'Must return raw bearer token');
      assert.ok(sessionResult.sessionId, 'Must return session ID');

      // Query database directly to confirm token is hashed at rest
      const stored = await tx.findById('sessions', sessionResult.sessionId);
      assert.ok(stored, 'Session must exist in DB');
      assert.notStrictEqual(stored.token_hash, sessionResult.token, 'Raw token must NEVER be stored');
      assert.strictEqual(stored.token_hash, hashToken(sessionResult.token), 'Hash in DB must match SHA-256');
    });
  });
});
