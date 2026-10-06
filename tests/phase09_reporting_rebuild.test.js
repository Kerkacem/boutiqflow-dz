const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const { processSale } = require('../src/pos/register');
const { recordExpense } = require('../src/finance/finance');
const { ReadModelService, ReportingService } = require('../src/reporting');

test('Phase 09 — Read Model Rebuildability & Invariance Suite (INV-09-08, INV-09-09, Section 29)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let locationId = null;
  let cashierId = null;
  let registerId = null;
  let sessionId = null;
  let variantId = null;

  await t.test('Setup: Seed variant and process 3 POS sales across multiple days', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Setif', type: 'shop' });
      locationId = loc.id;

      const user = await tx.insert('users', {
        name: 'Ali Caissier',
        email: 'ali@boutiqflow.dz',
        role: 'cashier',
        password_hash: 'hash'
      });
      cashierId = user.id;

      const reg = await tx.insert('cash_registers', { name: 'Caisse Setif', location_id: locationId });
      registerId = reg.id;

      const sess = await tx.insert('register_sessions', {
        register_id: reg.id,
        cashier_id: cashierId,
        opening_float_centimes: 500000n,
        status: 'OPEN'
      });
      sessionId = sess.id;

      const prod = await tx.insert('products', { name: 'Veste Cuir', category: 'Vestes' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'VES-CUI-MAR-L',
        size: 'L',
        color: 'Marron',
        cost_price: 500000n, // 5,000 DA
        sale_price: 900000n  // 9,000 DA
      });
      variantId = variant.id;

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId,
        quantity: 20,
        qty: 20,
        movementType: 'IN',
        costPriceCentimes: 500000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      // Sale 1: 2 units (18,000 DA)
      await processSale(tx, {
        sessionId,
        registerId,
        locationId,
        cashierId,
        items: [{ variantId, qty: 2, quantity: 2, unitPriceCentimes: 900000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 1800000n }],
        idempotencyKey: 'SALE-REBUILD-01'
      });

      // Sale 2: 1 unit (9,000 DA)
      await processSale(tx, {
        sessionId,
        registerId,
        locationId,
        cashierId,
        items: [{ variantId, qty: 1, quantity: 1, unitPriceCentimes: 900000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 900000n }],
        idempotencyKey: 'SALE-REBUILD-02'
      });

      // Operating Expense: 2,500 DA
      await recordExpense(tx, {
        categoryId: 'RENT',
        amountCentimes: 250000n,
        description: 'Loyer boutique',
        createdBy: cashierId,
        operationId: 'EXP-REBUILD-01'
      });
    });
  });

  await t.test('Section 29: Wipe read models -> Rebuild from canonical sources -> Exact match', async () => {
    let preRebuildRevenue = null;
    let preRebuildProfit = null;

    // 1. Initial rebuild and baseline query
    await db.withTenant({ tenantId }, async (tx) => {
      await ReadModelService.rebuildReadModels(tx);
      const profit = await ReportingService.getProfitSummary(tx);
      preRebuildRevenue = profit.revenueCentimes;
      preRebuildProfit = profit.operatingProfitCentimes;

      assert.strictEqual(preRebuildRevenue, 2700000n, 'Total revenue is 27,000 DA (3 units x 9,000 DA)');
      assert.strictEqual(profit.cogsCentimes, 1500000n, 'COGS is 15,000 DA (3 units x 5,000 DA)');
      assert.strictEqual(profit.grossProfitCentimes, 1200000n, 'Gross Profit is 12,000 DA');
      assert.strictEqual(profit.operatingExpensesCentimes, 250000n, 'Expenses are 2,500 DA');
      assert.strictEqual(preRebuildProfit, 950000n, 'Operating Profit is 9,500 DA');
    });

    // 2. Deliberately purge read model summary tables
    await db.withTenant({ tenantId }, async (tx) => {
      const summaries = await tx.query('daily_sales_summaries', s => s.tenant_id === tenantId);
      for (const s of summaries) await tx.delete('daily_sales_summaries', s.id);

      const profits = await tx.query('daily_profit_summaries', p => p.tenant_id === tenantId);
      for (const p of profits) await tx.delete('daily_profit_summaries', p.id);

      const invs = await tx.query('inventory_summaries', i => i.tenant_id === tenantId);
      for (const i of invs) await tx.delete('inventory_summaries', i.id);

      // Verify empty
      const afterWipe = await tx.query('daily_sales_summaries', s => s.tenant_id === tenantId);
      assert.strictEqual(afterWipe.length, 0, 'Read model summaries completely wiped');
    });

    // 3. Rebuild again from canonical sources (INV-09-08)
    await db.withTenant({ tenantId }, async (tx) => {
      const rebuildRes = await ReadModelService.rebuildReadModels(tx);
      assert.strictEqual(rebuildRes.success, true);

      // Verify restored read model records
      const postRebuildSummaries = await tx.query('daily_sales_summaries', s => s.tenant_id === tenantId);
      assert.ok(postRebuildSummaries.length > 0, 'Summaries restored');

      const profitAfter = await ReportingService.getProfitSummary(tx);
      assert.strictEqual(profitAfter.revenueCentimes, preRebuildRevenue, 'Rebuilt revenue matches exactly');
      assert.strictEqual(profitAfter.operatingProfitCentimes, preRebuildProfit, 'Rebuilt profit matches exactly');
    });
  });
});
