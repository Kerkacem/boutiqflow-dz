const test = require('node:test');
const assert = require('node:assert');
const { ROLES, PERMISSIONS, hasPermission, authorize } = require('../src/rbac/permissions');

test('Phase 13 — Comprehensive Authorization Matrix Red Team (INV-13-07, Requirement 13)', async (t) => {
  await t.test('1. Server-side fail-closed default: unknown role or unknown permission is DENIED (INV-13-07)', () => {
    assert.strictEqual(hasPermission('HACKER_ROLE', PERMISSIONS.SALES_READ), false);
    assert.strictEqual(hasPermission(ROLES.CASHIER, 'UNKNOWN:PERMISSION'), false);
    assert.strictEqual(hasPermission(null, PERMISSIONS.SALES_READ), false);
    assert.strictEqual(hasPermission(ROLES.OWNER, null), false);

    assert.throws(
      () => authorize('INTRUDER', PERMISSIONS.CATALOG_READ),
      (err) => err.statusCode === 403 && err.code === 'FORBIDDEN'
    );
  });

  await t.test('2. Cashier role boundaries strictly enforced', () => {
    // Permitted
    assert.strictEqual(hasPermission(ROLES.CASHIER, PERMISSIONS.SALES_CREATE), true);
    assert.strictEqual(hasPermission(ROLES.CASHIER, PERMISSIONS.CASH_REGISTER_OPEN), true);

    // Strictly blocked
    const blockedForCashier = [
      PERMISSIONS.CATALOG_VIEW_COST,
      PERMISSIONS.FINANCE_VIEW_PROFIT,
      PERMISSIONS.SALES_VOID,
      PERMISSIONS.PRICE_OVERRIDE,
      PERMISSIONS.ROLES_MANAGE,
      PERMISSIONS.DATA_EXPORT,
      PERMISSIONS.PURCHASES_MANAGE
    ];

    for (const perm of blockedForCashier) {
      assert.strictEqual(hasPermission(ROLES.CASHIER, perm), false, `Cashier must not have ${perm}`);
      assert.throws(
        () => authorize(ROLES.CASHIER, perm),
        (err) => err.statusCode === 403
      );
    }
  });

  await t.test('3. Stock Manager & Online Manager boundaries strictly enforced', () => {
    // Stock Manager cannot view profits or costs
    assert.strictEqual(hasPermission(ROLES.STOCK_MANAGER, PERMISSIONS.INVENTORY_TRANSFER), true);
    assert.strictEqual(hasPermission(ROLES.STOCK_MANAGER, PERMISSIONS.CATALOG_VIEW_COST), false);
    assert.strictEqual(hasPermission(ROLES.STOCK_MANAGER, PERMISSIONS.FINANCE_VIEW_PROFIT), false);

    // Online Manager can manage orders and COD, but cannot view store profits or modify roles
    assert.strictEqual(hasPermission(ROLES.ONLINE_MANAGER, PERMISSIONS.ONLINE_ORDERS_MANAGE), true);
    assert.strictEqual(hasPermission(ROLES.ONLINE_MANAGER, PERMISSIONS.COD_CONFIRM), true);
    assert.strictEqual(hasPermission(ROLES.ONLINE_MANAGER, PERMISSIONS.FINANCE_VIEW_PROFIT), false);
    assert.strictEqual(hasPermission(ROLES.ONLINE_MANAGER, PERMISSIONS.ROLES_MANAGE), false);
  });

  await t.test('4. Accountant role: Read-only financial oversight, zero operational mutations', () => {
    assert.strictEqual(hasPermission(ROLES.ACCOUNTANT, PERMISSIONS.FINANCE_VIEW_PROFIT), true);
    assert.strictEqual(hasPermission(ROLES.ACCOUNTANT, PERMISSIONS.CATALOG_VIEW_COST), true);
    assert.strictEqual(hasPermission(ROLES.ACCOUNTANT, PERMISSIONS.DATA_EXPORT), true);

    // Mutations blocked
    assert.strictEqual(hasPermission(ROLES.ACCOUNTANT, PERMISSIONS.SALES_CREATE), false);
    assert.strictEqual(hasPermission(ROLES.ACCOUNTANT, PERMISSIONS.INVENTORY_ADJUST), false);
    assert.strictEqual(hasPermission(ROLES.ACCOUNTANT, PERMISSIONS.PURCHASES_RECEIVE), false);
  });
});
