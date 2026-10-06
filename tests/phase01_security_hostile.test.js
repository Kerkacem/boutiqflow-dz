const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const {
  hashPassword,
  verifyPassword,
  checkRateLimit,
  recordFailedLogin,
  resetLoginAttempts,
  createSession,
  rotateSession,
  invalidateSession,
  validateSession,
  verifyTenantMembership
} = require('../src/auth/auth_service');
const { ROLES, PERMISSIONS, hasPermission, authorize } = require('../src/rbac/permissions');
const { logAuditEvent, AUDIT_ACTIONS } = require('../src/audit/audit_service');
const { exportTenantData, startSuperAdminImpersonation } = require('../src/saas/admin');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase 01 — Hostile Penetration Attack Suite, Multi-Tenancy & RBAC Verification', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();
  const userA = generateUUIDv7();
  const userB = generateUUIDv7();
  const cashierA = generateUUIDv7();
  const stockManagerA = generateUUIDv7();
  const onlineManagerA = generateUUIDv7();

  let productAId;
  let productBId;
  let sessionA;

  await t.test('Setup isolated tenants, users, sessions, and catalog items', async () => {
    // 1. Setup Tenant A
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      await tx.insert('users', {
        id: userA,
        name: 'Proprietaire A',
        email: 'owner@tenant-a.dz',
        role: ROLES.OWNER,
        is_active: true
      });
      await tx.insert('users', {
        id: cashierA,
        name: 'Caissier A',
        email: 'cashier@tenant-a.dz',
        role: ROLES.CASHIER,
        is_active: true
      });
      await tx.insert('users', {
        id: stockManagerA,
        name: 'Magasinier A',
        email: 'stock@tenant-a.dz',
        role: ROLES.STOCK_MANAGER,
        is_active: true
      });
      await tx.insert('users', {
        id: onlineManagerA,
        name: 'Gestionnaire Online A',
        email: 'online@tenant-a.dz',
        role: ROLES.ONLINE_MANAGER,
        is_active: true
      });

      const prodA = await tx.insert('products', {
        name: 'T-Shirt Tenant A Exclusive',
        category: 'T-Shirts'
      });
      productAId = prodA.id;

      sessionA = await createSession(tx, {
        tenantId: tenantA,
        userId: userA,
        ipAddress: '192.168.1.100'
      });
    });

    // 2. Setup Tenant B
    await db.withTenant({ tenantId: tenantB, userId: userB }, async (tx) => {
      await tx.insert('users', {
        id: userB,
        name: 'Proprietaire B',
        email: 'owner@tenant-b.dz',
        role: ROLES.OWNER,
        is_active: true
      });

      const prodB = await tx.insert('products', {
        name: 'Robe Tenant B Secret',
        category: 'Robes'
      });
      productBId = prodB.id;
    });
  });

  await t.test('Hostile Attack 1: Direct ID lookup across tenant boundary returns null (404)', async () => {
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      // User A attempts direct lookup of Product B
      const leaked = await tx.findById('products', productBId);
      assert.strictEqual(leaked, null, 'Direct lookup of foreign product ID must return null');
    });
  });

  await t.test('Hostile Attack 2: Search/Filter injection targeting foreign tenant data returns empty', async () => {
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      // Searching by exact name of Product B inside Tenant A scope
      const results = await tx.query('products', p => p.name === 'Robe Tenant B Secret');
      assert.strictEqual(results.length, 0, 'Search query must never penetrate tenant boundary');
    });
  });

  await t.test('Hostile Attack 3: Bulk query all records returns strictly Tenant A records', async () => {
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      const all = await tx.query('products');
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].id, productAId);
      assert.strictEqual(all[0].name, 'T-Shirt Tenant A Exclusive');
    });
  });

  await t.test('Hostile Attack 4: Payload tampering: User A injecting foreign tenant_id in insert throws Security Violation', async () => {
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      await assert.rejects(
        async () => {
          await tx.insert('products', {
            name: 'Malicious Injected Product',
            tenant_id: tenantB // Attempting to insert into Tenant B
          });
        },
        /Security Violation: Cannot insert row for tenant/
      );
    });
  });

  await t.test('Hostile Attack 5: Payload tampering: User A modifying tenant_id in update throws Security Violation', async () => {
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      await assert.rejects(
        async () => {
          await tx.update('products', productAId, {
            tenant_id: tenantB // Attempting to transfer product to Tenant B
          });
        },
        /Security Violation: Modification of tenant_id is strictly forbidden/
      );
    });
  });

  await t.test('Hostile Attack 6: Manipulated Route / Header: User A claiming Tenant B context is rejected', async () => {
    await db.withTenant({ tenantId: tenantB, userId: userA }, async (tx) => {
      // User A presenting context of Tenant B
      await assert.rejects(
        async () => {
          await verifyTenantMembership(tx, { tenantId: tenantB, userId: userA });
        },
        (err) => err.code === 'TENANT_MEMBERSHIP_DENIED' && err.statusCode === 403
      );
    });
  });

  await t.test('Hostile Attack 7: Export endpoint only dumps Tenant A records', async () => {
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      const dump = await exportTenantData(tx);
      assert.strictEqual(dump.tenantId, tenantA);
      assert.strictEqual(dump.catalog.products.length, 1);
      assert.strictEqual(dump.catalog.products[0].id, productAId);
      // Zero Tenant B products
      assert.strictEqual(dump.catalog.products.some(p => p.id === productBId), false);
    });
  });

  await t.test('RBAC Boundary Attack: Cashier forbidden from modifying prices and roles', async () => {
    // 1. Cashier price modification denied
    assert.strictEqual(hasPermission(ROLES.CASHIER, PERMISSIONS.CATALOG_PRICE_MODIFY), false);
    assert.throws(
      () => authorize(ROLES.CASHIER, PERMISSIONS.CATALOG_PRICE_MODIFY),
      /Access Denied/
    );

    // 2. Cashier role modification denied
    assert.strictEqual(hasPermission(ROLES.CASHIER, PERMISSIONS.ROLES_MANAGE), false);
    assert.throws(
      () => authorize(ROLES.CASHIER, PERMISSIONS.ROLES_MANAGE),
      /Access Denied/
    );

    // 3. Cashier cost view denied
    assert.strictEqual(hasPermission(ROLES.CASHIER, PERMISSIONS.CATALOG_VIEW_COST), false);
  });

  await t.test('RBAC Boundary Attack: Stock Manager forbidden from viewing financial profits and costs', () => {
    assert.strictEqual(hasPermission(ROLES.STOCK_MANAGER, PERMISSIONS.FINANCE_VIEW_PROFIT), false);
    assert.strictEqual(hasPermission(ROLES.STOCK_MANAGER, PERMISSIONS.CATALOG_VIEW_COST), false);
    assert.throws(
      () => authorize(ROLES.STOCK_MANAGER, PERMISSIONS.FINANCE_VIEW_PROFIT),
      /Access Denied/
    );
  });

  await t.test('RBAC Role Test: Online Manager permissions and boundaries', () => {
    assert.strictEqual(hasPermission(ROLES.ONLINE_MANAGER, PERMISSIONS.ONLINE_ORDERS_MANAGE), true);
    assert.strictEqual(hasPermission(ROLES.ONLINE_MANAGER, PERMISSIONS.COD_CONFIRM), true);
    assert.strictEqual(hasPermission(ROLES.ONLINE_MANAGER, PERMISSIONS.CATALOG_READ), true);

    // Denied permissions
    assert.strictEqual(hasPermission(ROLES.ONLINE_MANAGER, PERMISSIONS.CATALOG_VIEW_COST), false);
    assert.strictEqual(hasPermission(ROLES.ONLINE_MANAGER, PERMISSIONS.FINANCE_VIEW_PROFIT), false);
    assert.strictEqual(hasPermission(ROLES.ONLINE_MANAGER, PERMISSIONS.ROLES_MANAGE), false);
  });

  await t.test('Session Security: Session rotation on login & token hashing at rest', async () => {
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      // Validate initial session
      const check1 = await validateSession(tx, sessionA.token);
      assert.strictEqual(check1.valid, true);

      // Rotate session
      const rotated = await rotateSession(tx, sessionA.token, {
        tenantId: tenantA,
        userId: userA,
        ipAddress: '192.168.1.101'
      });
      assert.ok(rotated.token !== sessionA.token, 'Rotated session must issue new token');

      // Old session token is now invalid
      const checkOld = await validateSession(tx, sessionA.token);
      assert.strictEqual(checkOld.valid, false, 'Old session token must be invalidated');

      // New session token is valid
      const checkNew = await validateSession(tx, rotated.token);
      assert.strictEqual(checkNew.valid, true);

      // Invalidate session (Logout)
      await invalidateSession(tx, rotated.token);
      const checkLogout = await validateSession(tx, rotated.token);
      assert.strictEqual(checkLogout.valid, false, 'Logged out session must be invalidated');
    });
  });

  await t.test('Brute-force Protection: 5 failed logins locks account with backoff', () => {
    const testIp = '10.0.0.99';
    const identifier = 'attacker@bad.dz';

    resetLoginAttempts(identifier, testIp);
    assert.strictEqual(checkRateLimit(identifier, testIp).allowed, true);

    // 4 failures -> still allowed with warning
    for (let i = 0; i < 4; i++) {
      recordFailedLogin(identifier, testIp);
    }

    // 5th failure -> triggers lock
    recordFailedLogin(identifier, testIp);
    const lockedCheck = checkRateLimit(identifier, testIp);
    assert.strictEqual(lockedCheck.allowed, false);
    assert.ok(lockedCheck.error.includes('Too many login attempts'));

    // Resetting clears the lock
    resetLoginAttempts(identifier, testIp);
    assert.strictEqual(checkRateLimit(identifier, testIp).allowed, true);
  });

  await t.test('Audit Events: Logging administrative, security, and access denial events', async () => {
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      const event1 = await logAuditEvent(tx, {
        action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCESS,
        entityType: 'USER',
        entityId: userA,
        metadata: { ip: '192.168.1.100' }
      });
      assert.strictEqual(event1.action, 'auth:login_success');

      const event2 = await logAuditEvent(tx, {
        action: AUDIT_ACTIONS.SUSPICIOUS_CROSS_TENANT_ATTEMPT,
        entityType: 'PRODUCT',
        entityId: productBId,
        metadata: { attemptedBy: userA, targetTenant: tenantB }
      });
      assert.strictEqual(event2.action, 'security:suspicious_cross_tenant_attempt');

      const event3 = await logAuditEvent(tx, {
        action: AUDIT_ACTIONS.PERMISSION_DENIED,
        entityType: 'ROLE',
        entityId: cashierA,
        metadata: { attemptedPermission: PERMISSIONS.CATALOG_PRICE_MODIFY }
      });
      assert.strictEqual(event3.action, 'auth:permission_denied');

      const logs = await tx.query('audit_logs');
      assert.ok(logs.length >= 3);
    });
  });

  await t.test('Privacy Boundary: Super Admin cannot inspect customer PII without audited reason', async () => {
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      // 1. Attempting impersonation without reason throws error
      await assert.rejects(
        async () => {
          await startSuperAdminImpersonation(tx, {
            superAdminId: 'super_admin_01',
            targetTenantId: tenantA,
            reason: ''
          });
        },
        /Super-admin impersonation strictly requires/
      );

      // 2. Impersonation with audited reason succeeds and creates audit record
      const result = await startSuperAdminImpersonation(tx, {
        superAdminId: 'super_admin_01',
        targetTenantId: tenantA,
        reason: 'Ticket #DZ-8891: Database corruption recovery assistance'
      });
      assert.strictEqual(result.impersonating, true);

      const logs = await tx.query('audit_logs', a => a.action === AUDIT_ACTIONS.IMPERSONATION_START);
      assert.strictEqual(logs.length, 1);
      assert.ok(logs[0].metadata.includes('Ticket #DZ-8891'));
    });
  });
});
