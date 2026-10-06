const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  createSupplier,
  createPurchaseOrder,
  receiveGoods
} = require('../src/procurement/procurement_service');
const { defaultCostingService } = require('../src/procurement/costing_service');
const { processSale, TENDER_TYPES } = require('../src/pos/register');
const { generatePnLReport } = require('../src/finance/finance');

test('Phase 05 — Inventory Costing & Adversarial Cost Suite', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let supplierId = null;
  let locationId = null;
  let cashierId = null;
  let variantId = null;

  await t.test('Setup tenant, supplier, location, cashier, and variant', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Main Boutique', type: 'shop' });
      locationId = loc.id;

      const user = await tx.insert('users', { name: 'Karim', email: 'karim@shop.dz', role: 'cashier', password_hash: 'xxx' });
      cashierId = user.id;

      const sup = await createSupplier(tx, { name: 'Textiles Algerie', phone: '021112233' });
      supplierId = sup.id;

      const prod = await tx.insert('products', { name: 'Chemise Slim Fit' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'CHM-SLIM-WHT-M',
        size: 'M',
        color: 'Blanc',
        cost_price: 200000n, // Initial cost 2,000 DA (200,000 centimes)
        sale_price: 350000n  // Sale price 3,500 DA (350,000 centimes)
      });
      variantId = v.id;
    });
  });

  await t.test('Costing Engine: Moving Weighted Average Cost (WAC) formula verification', async () => {
    // 10 units @ 2000 DA + 10 units @ 2500 DA = 20 units @ 2250 DA
    const cost1 = defaultCostingService.calculateWeightedAverageCost({
      existingQty: 10,
      existingCostCentimes: 200000n,
      incomingQty: 10,
      incomingCostCentimes: 250000n
    });
    assert.strictEqual(cost1, 225000n, 'WAC should be 2,250 DA (225,000 centimes)');

    // When existing stock is zero or negative:
    const cost2 = defaultCostingService.calculateWeightedAverageCost({
      existingQty: 0,
      existingCostCentimes: 100000n,
      incomingQty: 15,
      incomingCostCentimes: 320000n
    });
    assert.strictEqual(cost2, 320000n, 'Initial stock at 0 takes incoming cost directly');
  });

  await t.test('Adversarial Cost Test (Requirement 21): Stock = 10 @ 2000, Receive 10 @ 3000 -> New WAC = 2500, Sell 4 -> COGS = 10000', async () => {
    // Step 1: Initial Purchase of 10 units @ 2000 DA
    await db.withTenant({ tenantId }, async (tx) => {
      const po1 = await createPurchaseOrder(tx, {
        supplierId,
        locationId,
        lines: [{ variantId, orderedQty: 10, unitCostCentimes: 200000n }]
      });
      await receiveGoods(tx, {
        purchaseOrderId: po1.id,
        locationId,
        receivedLines: [{ purchaseLineId: po1.lines[0].id, receivedQty: 10 }]
      });

      const v = await tx.findById('product_variants', variantId);
      assert.strictEqual(v.cost_price, 200000n, 'Variant cost price is 2,000 DA');
    });

    // Step 2: Receive 10 units @ 3000 DA (300,000 centimes)
    // New average = (10 * 2000 + 10 * 3000) / 20 = 2500 DA (250,000 centimes)
    await db.withTenant({ tenantId }, async (tx) => {
      const po2 = await createPurchaseOrder(tx, {
        supplierId,
        locationId,
        lines: [{ variantId, orderedQty: 10, unitCostCentimes: 300000n }]
      });
      await receiveGoods(tx, {
        purchaseOrderId: po2.id,
        locationId,
        receivedLines: [{ purchaseLineId: po2.lines[0].id, receivedQty: 10 }]
      });

      const v = await tx.findById('product_variants', variantId);
      assert.strictEqual(v.cost_price, 250000n, 'Variant cost price updated to new WAC = 2,500 DA');
    });

    // Step 3: Sell 4 units via POS
    // Total sale price = 4 * 3500 DA = 14,000 DA (1,400,000 centimes)
    // Expected COGS = 4 * 2500 DA = 10,000 DA (1,000,000 centimes)
    // Expected Gross Profit = 14,000 - 10,000 = 4,000 DA (400,000 centimes)
    let saleId = null;
    await db.withTenant({ tenantId }, async (tx) => {
      const saleResult = await processSale(tx, {
        locationId,
        cashierId,
        items: [{ variantId, qty: 4 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 1400000n }],
        idempotencyKey: 'adv_sale_4_units'
      });
      saleId = saleResult.saleId;
    });

    // Step 4: Verify initial report before any catalog edits
    await db.withTenant({ tenantId }, async (tx) => {
      const pnl = await generatePnLReport(tx);
      assert.strictEqual(pnl.grossSales, 1400000n, 'Gross Sales = 14,000 DA');
      assert.strictEqual(pnl.cogs, 1000000n, 'COGS = 4 * 2,500 DA = 10,000 DA');
      assert.strictEqual(pnl.grossProfit, 400000n, 'Gross Profit = 4,000 DA');
    });

    // Step 5: Adversarial attack: Manually edit current catalog cost price of variant
    await db.withTenant({ tenantId }, async (tx) => {
      await tx.update('product_variants', variantId, {
        cost_price: 999900n // Change to 9,999 DA
      });

      const v = await tx.findById('product_variants', variantId);
      assert.strictEqual(v.cost_price, 999900n, 'Variant cost price manually edited');
    });

    // Step 6: Invariant INV-05-05 & INV-05-06 Verification:
    // Historical sale lines and historical P&L COGS report must REMAIN completely unchanged!
    await db.withTenant({ tenantId }, async (tx) => {
      const saleLines = await tx.query('sale_items', i => i.sale_id === saleId);
      assert.strictEqual(saleLines.length, 1);
      assert.strictEqual(
        BigInt(saleLines[0].cost_snapshot_centimes),
        250000n,
        'INV-05-05: Historical sale line snapshot cost remains 2,500 DA permanently'
      );

      const pnlAfter = await generatePnLReport(tx);
      assert.strictEqual(
        pnlAfter.cogs,
        1000000n,
        'INV-05-06: Historical COGS never changes because of current catalog cost'
      );
      assert.strictEqual(
        pnlAfter.grossProfit,
        400000n,
        'INV-05-06: Historical Gross Profit remains exactly 4,000 DA'
      );
    });
  });

  await t.test('Multi-receipt sequence retains accurate cost history and layer integrity', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Current stock on hand is 16 (20 received - 4 sold)
      // Current WAC is 999900n (from manual edit) or 250000n if reset. Let's reset to 250000n.
      await tx.update('product_variants', variantId, { cost_price: 250000n });

      // Receive 16 more @ 3500 DA (350,000 centimes)
      // New WAC = (16 * 2500 + 16 * 3500) / 32 = 3000 DA (300,000 centimes)
      const po = await createPurchaseOrder(tx, {
        supplierId,
        locationId,
        lines: [{ variantId, orderedQty: 16, unitCostCentimes: 350000n }]
      });
      await receiveGoods(tx, {
        purchaseOrderId: po.id,
        locationId,
        receivedLines: [{ purchaseLineId: po.lines[0].id, receivedQty: 16 }]
      });

      const v = await tx.findById('product_variants', variantId);
      assert.strictEqual(v.cost_price, 300000n, 'New moving WAC equals 3,000 DA');

      // Check receipt lines snapshot cost (INV-05-04)
      const receiptLines = await tx.query('purchase_receipt_lines', rl => rl.variant_id === variantId);
      const latestReceiptLine = receiptLines[receiptLines.length - 1];
      assert.strictEqual(
        BigInt(latestReceiptLine.unit_cost_centimes),
        350000n,
        'INV-05-04: Receipt line records exact incoming purchase cost of 3,500 DA'
      );
    });
  });
});
