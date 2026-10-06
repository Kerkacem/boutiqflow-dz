const test = require('node:test');
const assert = require('node:assert');
const { ROLES, PERMISSIONS, hasPermission, authorize } = require('../src/rbac/permissions');

test('RBAC Permission Matrix — Principle of Least Privilege', async (t) => {
  await t.test('Cashier Permission Boundary: Restricted Access', () => {
    // Allowed actions
    assert.strictEqual(hasPermission(ROLES.CASHIER, PERMISSIONS.SALES_CREATE), true);
    assert.strictEqual(hasPermission(ROLES.CASHIER, PERMISSIONS.SALES_READ), true);
    assert.strictEqual(hasPermission(ROLES.CASHIER, PERMISSIONS.CATALOG_READ), true);

    // FORBIDDEN actions (Must be strictly denied)
    assert.strictEqual(hasPermission(ROLES.CASHIER, PERMISSIONS.CATALOG_VIEW_COST), false, 'Cashier must NOT see cost prices');
    assert.strictEqual(hasPermission(ROLES.CASHIER, PERMISSIONS.FINANCE_VIEW_PROFIT), false, 'Cashier must NOT see profit/margin');
    assert.strictEqual(hasPermission(ROLES.CASHIER, PERMISSIONS.SALES_VOID), false, 'Cashier must NOT void sales');
    assert.strictEqual(hasPermission(ROLES.CASHIER, PERMISSIONS.DATA_EXPORT), false, 'Cashier must NOT export data');

    // Authorize function throws 403 on denied permission
    assert.throws(
      () => authorize(ROLES.CASHIER, PERMISSIONS.CATALOG_VIEW_COST),
      (err) => err.statusCode === 403 && err.code === 'FORBIDDEN'
    );
  });

  await t.test('Stock Clerk Permission Boundary', () => {
    assert.strictEqual(hasPermission(ROLES.STOCK_CLERK, PERMISSIONS.INVENTORY_READ), true);
    assert.strictEqual(hasPermission(ROLES.STOCK_CLERK, PERMISSIONS.INVENTORY_TRANSFER), true);
    assert.strictEqual(hasPermission(ROLES.STOCK_CLERK, PERMISSIONS.INVENTORY_ADJUST), true);

    // Must NOT see costs or profits
    assert.strictEqual(hasPermission(ROLES.STOCK_CLERK, PERMISSIONS.CATALOG_VIEW_COST), false);
    assert.strictEqual(hasPermission(ROLES.STOCK_CLERK, PERMISSIONS.FINANCE_VIEW_PROFIT), false);
  });

  await t.test('Accountant Permission Boundary: Read-Only Financial Oversight', () => {
    assert.strictEqual(hasPermission(ROLES.ACCOUNTANT, PERMISSIONS.FINANCE_VIEW_PROFIT), true);
    assert.strictEqual(hasPermission(ROLES.ACCOUNTANT, PERMISSIONS.CATALOG_VIEW_COST), true);
    assert.strictEqual(hasPermission(ROLES.ACCOUNTANT, PERMISSIONS.DATA_EXPORT), true);

    // Read-only: cannot create sales or mutate inventory
    assert.strictEqual(hasPermission(ROLES.ACCOUNTANT, PERMISSIONS.SALES_CREATE), false);
    assert.strictEqual(hasPermission(ROLES.ACCOUNTANT, PERMISSIONS.INVENTORY_ADJUST), false);
    assert.strictEqual(hasPermission(ROLES.ACCOUNTANT, PERMISSIONS.SETTINGS_MANAGE), false);
  });

  await t.test('Manager and Owner Elevated Permissions', () => {
    assert.strictEqual(hasPermission(ROLES.MANAGER, PERMISSIONS.SALES_VOID), true);
    assert.strictEqual(hasPermission(ROLES.MANAGER, PERMISSIONS.CATALOG_VIEW_COST), true);
    assert.strictEqual(hasPermission(ROLES.MANAGER, PERMISSIONS.FINANCE_VIEW_PROFIT), true);

    // Owner has every permission
    for (const perm of Object.values(PERMISSIONS)) {
      assert.strictEqual(hasPermission(ROLES.OWNER, perm), true, `Owner must have ${perm}`);
    }
  });
});
