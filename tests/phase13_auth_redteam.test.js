const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  hashPassword,
  verifyPassword,
  createSession,
  validateSession,
  invalidateSession,
  revokeUserSessions,
  recordFailedLogin,
  checkRateLimit,
  resetLoginAttempts
} = require('../src/auth/auth_service');

test('Phase 13 — Authentication Red Team & Session Security (INV-13-06, Requirements 11 & 12)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Credential Stuffing & Brute Force Lockout (Requirement 11)', () => {
    const identifier = 'attacker@boutique.dz';
    const ip = '197.100.1.5';
    resetLoginAttempts(identifier, ip);

    // Initial check: allowed
    assert.strictEqual(checkRateLimit(identifier, ip).allowed, true);

    // 5 consecutive failed login attempts
    for (let i = 1; i <= 5; i++) {
      recordFailedLogin(identifier, ip);
    }

    // 6th attempt should be strictly locked out
    const rateCheck = checkRateLimit(identifier, ip);
    assert.strictEqual(rateCheck.allowed, false);
    assert.match(rateCheck.error, /Too many login attempts/);
  });

  await t.test('2. Session Security: Logout destroys session; reuse is rejected (Requirement 12)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const user = await tx.insert('users', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        email: 'user@boutique.dz',
        role: 'CASHIER'
      });

      // Login -> Session created
      const session = await createSession(tx, {
        userId: user.id,
        tenantId,
        ipAddress: '10.0.0.1'
      });
      assert.ok(session.token);

      // Validate session works
      const validated = await validateSession(tx, session.token);
      assert.strictEqual(validated.valid, true);
      assert.strictEqual(validated.session.user_id, user.id);

      // Logout -> Invalidate session
      await invalidateSession(tx, session.token);

      // Reuse attempt of invalidated session token must fail
      const reused = await validateSession(tx, session.token);
      assert.strictEqual(reused.valid, false);
    });
  });

  await t.test('3. Password Change Revokes All Existing Sessions (Requirement 12)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const user = await tx.insert('users', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        email: 'owner@boutique.dz',
        role: 'OWNER'
      });

      // User has 2 active sessions (e.g. mobile POS and laptop)
      const sess1 = await createSession(tx, { userId: user.id, tenantId, ipAddress: '10.0.0.1' });
      const sess2 = await createSession(tx, { userId: user.id, tenantId, ipAddress: '10.0.0.2' });

      assert.strictEqual((await validateSession(tx, sess1.token)).valid, true);
      assert.strictEqual((await validateSession(tx, sess2.token)).valid, true);

      // Password changed -> revoke all user sessions
      await revokeUserSessions(tx, user.id);

      // Both previously active sessions are now invalid
      assert.strictEqual((await validateSession(tx, sess1.token)).valid, false);
      assert.strictEqual((await validateSession(tx, sess2.token)).valid, false);
    });
  });
});
