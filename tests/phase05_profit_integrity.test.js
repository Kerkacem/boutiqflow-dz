const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  createSupplier,
  createPurchaseOrder,
  receiveGoods
} = require('../src/procurement/procurement_service');
const { recordSupplierPayment } = require('../src/procurement/payables_service');
const { processSale, TENDER_TYPES } = require('../src/pos/register');
const {
  recordExpense,
  generatePnLReport,
  calculateFinancialState,
  EXPENSE_CATEGORIES
} = require('../src/finance/finance');

test('Phase 05 — Profit Integrity & Financial Consistency Suite', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let supplierId = null;
  let locationId = null;
  let cashierId = null;
  let variantId = null;

  await t.test('Setup tenant, location, cashier, supplier, and catalog', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Sidi Yahia Store', type: 'shop' });
      locationId = loc.id;

      const user = await tx.insert('users', { name: 'Farid', email: 'farid@shop.dz', role: 'cashier', password_hash: 'xxx' });
      cashierId = user.id;

      const sup = await createSupplier(tx, { name: 'Importateur Textile Alger', phone: '023456789' });
      supplierId = sup.id;

      const prod = await tx.insert('products', { name: 'Polo Piqué Coton' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'POLO-COT-NVY-XL',
        size: 'XL',
        color: 'Navy',
        cost_price: 200000n, // 2,000 DA
        sale_price: 400000n  // 4,000 DA
      });
      variantId = v.id;
    });
  });

  await t.test('Discounts reduce Revenue, but do NOT reduce COGS (INV-05-12)', async () => {
    // 1. Receive 10 units @ 2,000 DA
    await db.withTenant({ tenantId }, async (tx) => {
      const po = await createPurchaseOrder(tx, {
        supplierId,
        locationId,
        lines: [{ variantId, orderedQty: 10, unitCostCentimes: 200000n }]
      });
      await receiveGoods(tx, {
        purchaseOrderId: po.id,
        locationId,
        receivedLines: [{ purchaseLineId: po.lines[0].id, receivedQty: 10 }]
      });
    });

    // 2. Sell 2 units @ 4,000 DA = 8,000 DA subtotal. Apply 1,000 DA cart discount.
    // Net Revenue = 7,000 DA (700,000 centimes).
    // Unit cost = 2,000 DA. COGS must be 2 * 2,000 = 4,000 DA (400,000 centimes).
    // Gross Profit = 7,000 - 4,000 = 3,000 DA (300,000 centimes).
    await db.withTenant({ tenantId }, async (tx) => {
      await processSale(tx, {
        locationId,
        cashierId,
        items: [{ variantId, qty: 2 }],
        discountCentimes: 100000n, // 1,000 DA discount
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 700000n }],
        idempotencyKey: 'sale_with_discount_p05'
      });

      const pnl = await generatePnLReport(tx);
      assert.strictEqual(pnl.grossSales, 700000n, 'Revenue reflects net sale after discount (7,000 DA)');
      assert.strictEqual(pnl.cogs, 400000n, 'COGS strictly reflects unit cost without distortion (4,000 DA)');
      assert.strictEqual(pnl.grossProfit, 300000n, 'Gross Profit = 7,000 DA - 4,000 DA = 3,000 DA');
    });
  });

  await t.test('Historical Profit Integrity (INV-05-05, INV-05-06, INV-05-15)', async () => {
    // Current state has 1 sale with Revenue = 7,000 DA, COGS = 4,000 DA, Gross Profit = 3,000 DA.
    // Now receive new batch at a much higher cost: 5 units @ 3,500 DA (350,000 centimes).
    await db.withTenant({ tenantId }, async (tx) => {
      const po = await createPurchaseOrder(tx, {
        supplierId,
        locationId,
        lines: [{ variantId, orderedQty: 5, unitCostCentimes: 350000n }]
      });
      await receiveGoods(tx, {
        purchaseOrderId: po.id,
        locationId,
        receivedLines: [{ purchaseLineId: po.lines[0].id, receivedQty: 5 }]
      });

      // The catalog variant cost_price has now increased because of new WAC
      const v = await tx.findById('product_variants', variantId);
      assert.ok(v.cost_price > 200000n, 'Catalog cost price increased due to new shipment');

      // But past sales report must NOT be recomputed with the higher cost!
      const pnl = await generatePnLReport(tx);
      assert.strictEqual(pnl.cogs, 400000n, 'INV-05-06: Historical COGS remains 4,000 DA');
      assert.strictEqual(pnl.grossProfit, 300000n, 'INV-05-15: Historical Gross Profit remains 3,000 DA');
    });
  });

  await t.test('Financial Consistency Balance Test (Requirement 22): Full multi-variable lifecycle reconciles to the centime', async () => {
    const freshTenant = generateUUIDv7();
    let shopLocId = null;
    let freshCashierId = null;
    let freshSupId = null;
    let jeanVarId = null;

    // 1. Setup fresh tenant
    await db.withTenant({ tenantId: freshTenant }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Oran Shop', type: 'shop' });
      shopLocId = loc.id;
      const u = await tx.insert('users', { name: 'Adel', role: 'cashier', email: 'adel@oran.dz' });
      freshCashierId = u.id;
      const sup = await createSupplier(tx, { name: 'Denim Factory Blida' });
      freshSupId = sup.id;
      const prod = await tx.insert('products', { name: 'Jean Regular' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'JN-REG-BLU-40',
        size: '40',
        color: 'Bleu',
        cost_price: 200000n, // 2,000 DA
        sale_price: 350000n  // 3,500 DA
      });
      jeanVarId = v.id;
    });

    // 2. Action A: Purchase 10 jeans @ 2,000 DA on credit
    // Expected: Stock Value = +20,000 DA, Supplier Payable = +20,000 DA, Cash = 0 DA
    await db.withTenant({ tenantId: freshTenant }, async (tx) => {
      const po = await createPurchaseOrder(tx, {
        supplierId: freshSupId,
        locationId: shopLocId,
        lines: [{ variantId: jeanVarId, orderedQty: 10, unitCostCentimes: 200000n }]
      });
      await receiveGoods(tx, {
        purchaseOrderId: po.id,
        locationId: shopLocId,
        receivedLines: [{ purchaseLineId: po.lines[0].id, receivedQty: 10 }]
      });

      const stateA = await calculateFinancialState(tx);
      assert.strictEqual(stateA.inventoryValue, 2000000n, 'Stock Value = 20,000 DA');
      assert.strictEqual(stateA.supplierPayables, 2000000n, 'Supplier Payable = 20,000 DA');
      assert.strictEqual(stateA.revenue, 0n);
      assert.strictEqual(stateA.cogs, 0n);
      assert.strictEqual(stateA.grossProfit, 0n);
      assert.strictEqual(stateA.operatingExpenses, 0n);
      assert.strictEqual(stateA.operatingProfit, 0n);
    });

    // 3. Action B: Sell 6 jeans for cash @ 3,500 DA = 21,000 DA (2,100,000 centimes)
    // Expected:
    // Revenue = 21,000 DA
    // COGS = 6 * 2,000 DA = 12,000 DA (1,200,000 centimes)
    // Gross Profit = 21,000 - 12,000 = 9,000 DA (900,000 centimes)
    // Remaining Inventory Value = 4 * 2,000 = 8,000 DA (800,000 centimes)
    // Supplier Payable remains 20,000 DA
    await db.withTenant({ tenantId: freshTenant }, async (tx) => {
      await processSale(tx, {
        locationId: shopLocId,
        cashierId: freshCashierId,
        items: [{ variantId: jeanVarId, qty: 6 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 2100000n }],
        idempotencyKey: 'jean_sale_6_units'
      });

      const stateB = await calculateFinancialState(tx);
      assert.strictEqual(stateB.revenue, 2100000n, 'Revenue = 21,000 DA');
      assert.strictEqual(stateB.cogs, 1200000n, 'COGS = 12,000 DA');
      assert.strictEqual(stateB.grossProfit, 900000n, 'Gross Profit = 9,000 DA');
      assert.strictEqual(stateB.inventoryValue, 800000n, 'Remaining Stock Value = 8,000 DA');
      assert.strictEqual(stateB.supplierPayables, 2000000n, 'Supplier Payable still 20,000 DA');
    });

    // 4. Action C: Pay operating expense: 4,000 DA (400,000 centimes) for electricity
    // Expected:
    // Operating Expenses = 4,000 DA
    // Operating Profit = Gross Profit (9,000) - Expenses (4,000) = 5,000 DA (500,000 centimes)
    await db.withTenant({ tenantId: freshTenant }, async (tx) => {
      await recordExpense(tx, {
        categoryId: EXPENSE_CATEGORIES.ELECTRICITY,
        amountCentimes: 400000n,
        description: 'Store electricity'
      });

      const stateC = await calculateFinancialState(tx);
      assert.strictEqual(stateC.operatingExpenses, 400000n, 'Operating Expenses = 4,000 DA');
      assert.strictEqual(stateC.operatingProfit, 500000n, 'Operating Profit = 5,000 DA (9,000 - 4,000)');
    });

    // 5. Action D: Pay supplier 15,000 DA (1,500,000 centimes)
    // Expected:
    // Supplier Payable = 20,000 - 15,000 = 5,000 DA (500,000 centimes)
    // Operating profit remains 5,000 DA (supplier payment is NOT an expense)
    await db.withTenant({ tenantId: freshTenant }, async (tx) => {
      await recordSupplierPayment(tx, {
        supplierId: freshSupId,
        amountCentimes: 1500000n
      });

      const stateD = await calculateFinancialState(tx);
      assert.strictEqual(stateD.supplierPayables, 500000n, 'Supplier Payable reduced to 5,000 DA');
      assert.strictEqual(stateD.operatingExpenses, 400000n, 'Operating Expenses unchanged (4,000 DA)');
      assert.strictEqual(stateD.operatingProfit, 500000n, 'Operating Profit unchanged (5,000 DA)');
      assert.strictEqual(stateD.inventoryValue, 800000n, 'Inventory Value unchanged (8,000 DA)');
    });
  });
});
