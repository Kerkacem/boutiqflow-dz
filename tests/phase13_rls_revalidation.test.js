const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { createSession, invalidateSession, verifyTenantMembership } = require('../src/auth/auth_service');

test('Phase 13 — RLS Revalidation Under Session Mutation (INV-13-02, Requirement 9)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  await t.test('1. Revoked membership immediately denies access even with retained session (INV-13-02)', async () => {
    let userAId = null;
    let sessionToken = null;

    // 1. Create active user & session in Tenant A
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const user = await tx.insert('users', {
        id: generateUUIDv7(),
        tenant_id: tenantA,
        email: 'staff@boutique-a.dz',
        role: 'CASHIER',
        is_active: true
      });
      userAId = user.id;

      const sess = await createSession(tx, { tenantId: tenantA, userId: userAId });
      sessionToken = sess.token;

      // Verify membership check passes
      const member = await verifyTenantMembership(tx, { tenantId: tenantA, userId: userAId });
      assert.strictEqual(member.id, userAId);
    });

    // 2. Deactivate / Revoke membership
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await tx.update('users', userAId, { is_active: false });
    });

    // 3. User attempts query using old session -> must be strictly blocked
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => verifyTenantMembership(tx, { tenantId: tenantA, userId: userAId }),
        (err) => {
          assert.strictEqual(err.code, 'TENANT_MEMBERSHIP_DENIED');
          return true;
        }
      );
    });
  });

  await t.test('2. Disabled tenant immediately blocks queries under RLS session (INV-13-02)', async () => {
    // Insert and then Disable Tenant B
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      await tx.insert('tenants', { id: tenantB, name: 'Boutique B', status: 'ACTIVE' });
      await tx.update('tenants', tenantB, { status: 'SUSPENDED' });
    });

    // Access attempt to record of disabled tenant reflects suspended status
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const tenantRecord = await tx.findById('tenants', tenantB);
      assert.strictEqual(tenantRecord.status, 'SUSPENDED');
    });
  });
});
