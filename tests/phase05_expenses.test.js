const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  recordExpense,
  voidExpense,
  generatePnLReport,
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES
} = require('../src/finance/finance');
const {
  createSupplier,
  createPurchaseOrder,
  receiveGoods
} = require('../src/procurement/procurement_service');
const { authorize, PERMISSIONS } = require('../src/rbac/permissions');

test('Phase 05 — Operating Expenses & Immutability Suite', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let userAId = null;
  let userBId = null;

  await t.test('Setup isolated tenants and users', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const u = await tx.insert('users', { name: 'Manager A', email: 'mgr@shopa.dz', role: 'manager', password_hash: 'xxx' });
      userAId = u.id;
    });

    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const u = await tx.insert('users', { name: 'Manager B', email: 'mgr@shopb.dz', role: 'manager', password_hash: 'xxx' });
      userBId = u.id;
    });
  });

  await t.test('Record operating expenses across categories with positive amount validation', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 1. Negative amount rejected
      await assert.rejects(
        recordExpense(tx, {
          categoryId: EXPENSE_CATEGORIES.RENT,
          amountCentimes: -500000n
        }),
        /Expense amount must be strictly positive/
      );

      // 2. Zero amount rejected
      await assert.rejects(
        recordExpense(tx, {
          categoryId: EXPENSE_CATEGORIES.RENT,
          amountCentimes: 0n
        }),
        /Expense amount must be strictly positive/
      );

      // 3. Valid expenses recorded
      const rentExp = await recordExpense(tx, {
        categoryId: EXPENSE_CATEGORIES.RENT,
        amountCentimes: 8000000n, // 80,000 DA
        description: 'Boutique Store Rent',
        expenseDate: '2026-10-01',
        createdBy: userAId
      });
      assert.strictEqual(rentExp.status, EXPENSE_STATUSES.POSTED);

      const elecExp = await recordExpense(tx, {
        categoryId: EXPENSE_CATEGORIES.ELECTRICITY,
        amountCentimes: 1500000n, // 15,000 DA
        description: 'Sonelgaz bill',
        expenseDate: '2026-10-02',
        createdBy: userAId
      });
      assert.strictEqual(elecExp.status, EXPENSE_STATUSES.POSTED);

      const netExp = await recordExpense(tx, {
        categoryId: EXPENSE_CATEGORIES.INTERNET,
        amountCentimes: 400000n, // 4,000 DA
        description: 'Algerie Telecom 4G/Fiber',
        expenseDate: '2026-10-03',
        createdBy: userAId
      });
      assert.strictEqual(netExp.status, EXPENSE_STATUSES.POSTED);
    });
  });

  await t.test('INV-05-09: Posted expense attributes cannot be silently modified and cannot be deleted', async () => {
    let expId = null;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const exp = await recordExpense(tx, {
        categoryId: EXPENSE_CATEGORIES.TRANSPORT,
        amountCentimes: 200000n,
        description: 'Inter-store taxi',
        createdBy: userAId
      });
      expId = exp.id;
    });

    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 1. Attempt modifying amount
      await assert.rejects(
        tx.update('expenses', expId, { amount_centimes: 100000n }),
        /Expense Immutability Violation.*amount_centimes.*cannot be modified.*INV-05-09/
      );

      // 2. Attempt modifying category
      await assert.rejects(
        tx.update('expenses', expId, { category_id: EXPENSE_CATEGORIES.MARKETING }),
        /Expense Immutability Violation.*category_id.*cannot be modified.*INV-05-09/
      );

      // 3. Attempt modifying date
      await assert.rejects(
        tx.update('expenses', expId, { expense_date: '2026-09-01' }),
        /Expense Immutability Violation.*expense_date.*cannot be modified.*INV-05-09/
      );

      // 4. Attempt deleting posted expense
      await assert.rejects(
        tx.delete('expenses', expId),
        /Expense Immutability Violation: Posted or voided expenses cannot be deleted \(INV-05-09\)/
      );
    });
  });

  await t.test('Controlled void of expense: Updates status to VOIDED and excludes from P&L operating expenses', async () => {
    let expId = null;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const exp = await recordExpense(tx, {
        categoryId: EXPENSE_CATEGORIES.MAINTENANCE,
        amountCentimes: 3000000n, // 30,000 DA
        description: 'Air conditioning repair',
        expenseDate: '2026-10-04',
        createdBy: userAId
      });
      expId = exp.id;
    });

    // Check P&L before void
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const pnlBefore = await generatePnLReport(tx);
      // Expenses = 80k + 15k + 4k + 2k + 30k = 131,000 DA (13,100,000 centimes)
      assert.strictEqual(pnlBefore.totalExpenses, 13100000n);
    });

    // Void the 30,000 DA expense
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const voided = await voidExpense(tx, {
        expenseId: expId,
        voidedBy: userAId,
        reason: 'Duplicate voucher entered by mistake'
      });
      assert.strictEqual(voided.status, EXPENSE_STATUSES.VOIDED);

      // Attempt voiding already voided expense
      await assert.rejects(
        voidExpense(tx, { expenseId: expId, voidedBy: userAId }),
        /Expense is already VOIDED/
      );

      // Attempt deleting voided expense
      await assert.rejects(
        tx.delete('expenses', expId),
        /Expense Immutability Violation: Posted or voided expenses cannot be deleted/
      );
    });

    // Check P&L after void: 30,000 DA must be excluded!
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const pnlAfter = await generatePnLReport(tx);
      // Expenses = 131,000 - 30,000 = 101,000 DA (10,100,000 centimes)
      assert.strictEqual(pnlAfter.totalExpenses, 10100000n, 'Voided expense is strictly excluded from total operating expenses');
    });
  });

  await t.test('INV-05-12: Inventory Purchase is NOT an Operating Expense', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Store A', type: 'shop' });
      const sup = await createSupplier(tx, { name: 'Grossiste T-Shirts' });
      const prod = await tx.insert('products', { name: 'T-Shirt Blanc' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'TSH-WHT-S',
        size: 'S',
        color: 'Blanc',
        cost_price: 100000n,
        sale_price: 200000n
      });

      // Query total operating expenses before inventory purchase
      const pnlBefore = await generatePnLReport(tx);
      const expensesBefore = pnlBefore.totalExpenses;

      // Purchase 100 shirts @ 1,000 DA = 100,000 DA (10,000,000 centimes)
      const po = await createPurchaseOrder(tx, {
        supplierId: sup.id,
        locationId: loc.id,
        lines: [{ variantId: v.id, orderedQty: 100, unitCostCentimes: 100000n }]
      });
      await receiveGoods(tx, {
        purchaseOrderId: po.id,
        locationId: loc.id,
        receivedLines: [{ purchaseLineId: po.lines[0].id, receivedQty: 100 }]
      });

      // Query total operating expenses after purchase
      const pnlAfter = await generatePnLReport(tx);
      const expensesAfter = pnlAfter.totalExpenses;

      // Invariant INV-05-12: Inventory purchases do NOT inflate operating expenses!
      assert.strictEqual(
        expensesAfter,
        expensesBefore,
        'INV-05-12: Stock purchase of 100,000 DA must NOT enter operating expenses'
      );
    });
  });

  await t.test('INV-05-11: Cross-tenant expense isolation: Tenant B cannot view or void Tenant A expenses', async () => {
    let expAId = null;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const exp = await recordExpense(tx, {
        categoryId: EXPENSE_CATEGORIES.MARKETING,
        amountCentimes: 500000n,
        description: 'Facebook Ads Algiers',
        createdBy: userAId
      });
      expAId = exp.id;
    });

    await db.withTenant({ tenantId: tenantB }, async (txB) => {
      // 1. Direct lookup returns null
      const exp = await txB.findById('expenses', expAId);
      assert.strictEqual(exp, null);

      // 2. Void attempt throws not found
      await assert.rejects(
        voidExpense(txB, { expenseId: expAId, voidedBy: userBId }),
        /Expense not found/
      );
    });
  });

  await t.test('RBAC: Cashier role is forbidden from managing or recording expenses', async () => {
    assert.throws(
      () => authorize('cashier', PERMISSIONS.FINANCE_MANAGE_EXPENSES),
      /Access Denied: Role 'cashier' lacks required permission 'finance:manage_expenses'/
    );

    assert.throws(
      () => authorize('cashier', PERMISSIONS.FINANCE_VIEW_PROFIT),
      /Access Denied: Role 'cashier' lacks required permission 'finance:view_profit'/
    );
  });
});
