const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const { processSale } = require('../src/pos/register');
const { recordExpense } = require('../src/finance/finance');
const { ReportingService } = require('../src/reporting');

test('Phase 09 — Metrics Integrity & Critical Financial Scenario (INV-09-02, INV-09-04, INV-09-05, INV-09-18)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let locationId = null;
  let cashierId = null;
  let registerId = null;
  let sessionId = null;
  let productId = null;
  let variantId = null;
  let saleId = null;

  await t.test('Setup: Seed variant, purchase 10 units @ 2,000 DA (200,000 centimes)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Didouche', type: 'shop' });
      locationId = loc.id;

      const user = await tx.insert('users', {
        name: 'Sarah Caissière',
        email: 'sarah@boutiqflow.dz',
        role: 'cashier',
        password_hash: 'hash'
      });
      cashierId = user.id;

      const reg = await tx.insert('cash_registers', { name: 'Caisse 1', location_id: locationId });
      registerId = reg.id;

      const sess = await tx.insert('register_sessions', {
        register_id: reg.id,
        cashier_id: cashierId,
        opening_float_centimes: 1000000n,
        status: 'OPEN'
      });
      sessionId = sess.id;

      const prod = await tx.insert('products', { name: 'Robe Soirée Satin', category: 'Robes' });
      productId = prod.id;

      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'ROB-SAT-ROSE-38',
        size: '38',
        color: 'Rose',
        cost_price: 200000n, // 2,000 DA initial cost
        sale_price: 300000n  // 3,000 DA sale price
      });
      variantId = variant.id;

      // Purchase/receive 10 units at 2,000 DA
      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId,
        quantity: 10,
        qty: 10,
        movementType: 'IN',
        costPriceCentimes: 200000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });
  });

  await t.test('CRITICAL FINANCIAL SCENARIO (Section 49): Sale of 4 units @ 3,000 DA + 1,000 DA Operating Expense', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Sale: 4 x 3,000 DA = 12,000 DA revenue (1,200,000 centimes)
      const sale = await processSale(tx, {
        sessionId,
        registerId,
        locationId,
        cashierId,
        items: [{ variantId, qty: 4, quantity: 4, unitPriceCentimes: 300000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 1200000n }],
        idempotencyKey: 'SALE-METRICS-001'
      });
      saleId = sale.saleId;

      // 2. Operating Expense: 1,000 DA (100,000 centimes)
      await recordExpense(tx, {
        categoryId: 'PACKAGING',
        amountCentimes: 100000n,
        description: 'Sacs d emballage',
        createdBy: cashierId,
        operationId: 'EXP-METRICS-001'
      });

      // 3. Initial Financial Verification:
      const profit = await ReportingService.getProfitSummary(tx);
      assert.strictEqual(profit.revenueCentimes, 1200000n, 'Revenue must be 12,000 DA');
      assert.strictEqual(profit.cogsCentimes, 800000n, 'COGS must be 8,000 DA (4 x 2,000)');
      assert.strictEqual(profit.grossProfitCentimes, 400000n, 'Gross Profit must be 4,000 DA');
      assert.strictEqual(profit.operatingExpensesCentimes, 100000n, 'Operating Expenses must be 1,000 DA');
      assert.strictEqual(profit.operatingProfitCentimes, 300000n, 'Operating Profit must be 3,000 DA');
      assert.strictEqual(profit.grossMargin, '33.33%', 'Margin must be 33.33%');
    });
  });

  await t.test('INV-09-04 & INV-09-05: Subsequent variant cost change does NOT rewrite historical COGS or Profit', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Current supplier price increases to 2,500 DA (250,000 centimes)
      await tx.update('product_variants', variantId, {
        cost_price: 250000n
      });

      // Query reports again: Historical numbers MUST remain strictly unchanged!
      const profit = await ReportingService.getProfitSummary(tx);
      assert.strictEqual(profit.revenueCentimes, 1200000n, 'Revenue remains 12,000 DA');
      assert.strictEqual(profit.cogsCentimes, 800000n, 'COGS remains 8,000 DA despite cost change');
      assert.strictEqual(profit.grossProfitCentimes, 400000n, 'Gross Profit remains 4,000 DA');
      assert.strictEqual(profit.operatingExpensesCentimes, 100000n, 'Operating Expenses remains 1,000 DA');
      assert.strictEqual(profit.operatingProfitCentimes, 300000n, 'Operating Profit remains 3,000 DA');
    });
  });

  await t.test('INV-09-18: Archived product still appears in historical sales reports', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Archive product
      await tx.update('products', productId, {
        status: 'ARCHIVED'
      });

      const byProduct = await ReportingService.getSalesByProduct(tx);
      const row = byProduct.find(p => p.variantId === variantId);
      assert.ok(row, 'Archived product still appears in sales report');
      assert.strictEqual(row.unitsSold, 4);
      assert.strictEqual(row.revenueCentimes, 1200000n);
      assert.strictEqual(row.cogsCentimes, 800000n);
    });
  });
});
