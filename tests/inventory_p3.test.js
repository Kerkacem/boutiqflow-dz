const test = require('node:test');
const assert = require('node:assert');
const {
  applyStockMovement,
  createReservation,
  fulfillReservation,
  cancelReservation,
  transferStock,
  receiveSupplierGoods,
  reconcileStocktake,
  MOVEMENT_REASONS
} = require('../src/inventory/ledger');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase P3 — Inventory Ledger, Invariants, WAC & Stocktake', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let shopLocId = null;
  let warehouseLocId = null;
  let variantId = null;

  await t.test('Setup tenant locations and test product variant', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const shop = await tx.insert('inventory_locations', { name: 'Boutique Alger', type: 'shop' });
      const wh = await tx.insert('inventory_locations', { name: 'Dépôt Central', type: 'warehouse' });
      shopLocId = shop.id;
      warehouseLocId = wh.id;

      const product = await tx.insert('products', { name: 'Jean Slim Denim' });
      const variant = await tx.insert('product_variants', {
        product_id: product.id,
        sku: 'JEAN-SLIM-38',
        size: '38',
        color: 'Bleu Brut',
        cost_price: 200000n, // 2,000 DA
        sale_price: 380000n  // 3,800 DA
      });
      variantId = variant.id;
    });
  });

  await t.test('INV-1: on_hand == SUM(stock_movements.qty) across operations', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Initial receiving: +50 units
      await applyStockMovement(tx, {
        variantId,
        locationId: shopLocId,
        qty: 50,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      // 2. POS Sale: -3 units
      await applyStockMovement(tx, {
        variantId,
        locationId: shopLocId,
        qty: -3,
        reason: MOVEMENT_REASONS.POS_SALE
      });

      // 3. Customer Return: +1 unit
      await applyStockMovement(tx, {
        variantId,
        locationId: shopLocId,
        qty: 1,
        reason: MOVEMENT_REASONS.RETURN_RESTOCK
      });

      // 4. Damaged adjustment: -2 units
      await applyStockMovement(tx, {
        variantId,
        locationId: shopLocId,
        qty: -2,
        reason: MOVEMENT_REASONS.ADJUSTMENT
      });

      // Query stock level and sum movements
      const levels = await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === shopLocId);
      assert.strictEqual(levels.length, 1);
      const onHand = levels[0].on_hand;

      const movements = await tx.query('stock_movements', m => m.variant_id === variantId && m.location_id === shopLocId);
      const sumMovements = movements.reduce((acc, m) => acc + m.qty, 0);

      // Verify INV-1 invariant
      assert.strictEqual(onHand, 46, 'Expected on_hand = 50 - 3 + 1 - 2 = 46');
      assert.strictEqual(onHand, sumMovements, 'INV-1 violation: on_hand must equal sum of movements');
    });
  });

  await t.test('INV-2: available = on_hand - reserved, and reservation lifecycle', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Current on_hand is 46, reserved is 0, available is 46
      // Create online reservation for 5 units
      const res = await createReservation(tx, {
        variantId,
        locationId: shopLocId,
        qty: 5,
        orderId: generateUUIDv7()
      });

      let levels = (await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === shopLocId))[0];
      assert.strictEqual(levels.on_hand, 46, 'on_hand must not change on reservation creation');
      assert.strictEqual(levels.reserved, 5, 'reserved must be 5');
      assert.strictEqual(levels.available, 41, 'INV-2: available must be on_hand - reserved (46 - 5 = 41)');

      // Cannot over-reserve beyond available quantity
      await assert.rejects(
        async () => {
          await createReservation(tx, {
            variantId,
            locationId: shopLocId,
            qty: 50 // only 41 available
          });
        },
        /Cannot reserve: requested 50 but available is only 41/
      );

      // Fulfill 5 units on shipment
      await fulfillReservation(tx, res.id);

      levels = (await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === shopLocId))[0];
      assert.strictEqual(levels.on_hand, 41, 'on_hand decrements upon shipment');
      assert.strictEqual(levels.reserved, 0, 'reserved releases upon shipment');
      assert.strictEqual(levels.available, 41, 'available equals on_hand after fulfillment');
    });
  });

  await t.test('Location Transfers: Atomic Movement from Warehouse to Shop', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Seed warehouse with 20 units
      await applyStockMovement(tx, {
        variantId,
        locationId: warehouseLocId,
        qty: 20,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      // Transfer 10 units from warehouse to shop
      const result = await transferStock(tx, {
        variantId,
        fromLocationId: warehouseLocId,
        toLocationId: shopLocId,
        qty: 10
      });
      assert.strictEqual(result.success, true);

      const whLevel = (await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === warehouseLocId))[0];
      const shopLevel = (await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === shopLocId))[0];

      assert.strictEqual(whLevel.on_hand, 10, 'Warehouse should have 20 - 10 = 10 units');
      assert.strictEqual(shopLevel.on_hand, 51, 'Shop should have 41 + 10 = 51 units');
    });
  });

  await t.test('UAT-2: Supplier Purchasing with Weighted Average Cost (WAC) Update', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Create new variant: initial cost 2,000 DA (200,000 centimes), 10 in stock
      const p = await tx.insert('products', { name: 'Veste Cuir Pilote' });
      const v = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'VST-CUIR-L',
        size: 'L',
        color: 'Noir',
        cost_price: 200000n, // 2,000 DA
        sale_price: 450000n  // 4,500 DA
      });

      await applyStockMovement(tx, {
        variantId: v.id,
        locationId: shopLocId,
        qty: 10,
        costPriceCentimes: 200000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      // Supplier delivers 50 pieces at unit cost 2,600 DA (260,000 centimes)
      // Expected New WAC = ((10 * 2000) + (50 * 2600)) / (10 + 50) = (20000 + 130000) / 60 = 150000 / 60 = 2,500 DA (250,000 centimes)
      const receivingResult = await receiveSupplierGoods(tx, {
        variantId: v.id,
        locationId: shopLocId,
        qty: 50,
        unitCostCentimes: 260000n
      });

      assert.strictEqual(receivingResult.newOnHand, 60, 'Total stock must be 10 + 50 = 60');
      assert.strictEqual(receivingResult.newWac, 250000n, 'WAC must update to 2,500 DA (250,000 centimes)');

      // Verify variant record in database holds new WAC
      const updatedVariant = await tx.findById('product_variants', v.id);
      assert.strictEqual(updatedVariant.cost_price, 250000n);
    });
  });

  await t.test('UAT-9: Physical Stocktake of 30 Variants with Discrepancy Adjustments', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const prod = await tx.insert('products', { name: 'T-Shirt Basic' });
      const variants = [];

      // Seed 30 variants with 10 units each
      for (let i = 1; i <= 30; i++) {
        const v = await tx.insert('product_variants', {
          product_id: prod.id,
          sku: `TSH-VAR-${i}`,
          size: `${i}`,
          color: 'Blanc',
          cost_price: 80000n,
          sale_price: 150000n
        });
        variants.push(v);
        await applyStockMovement(tx, {
          variantId: v.id,
          locationId: shopLocId,
          qty: 10,
          reason: MOVEMENT_REASONS.RECEIVING
        });
      }

      // Prepare physical count with 2 discrepancies:
      // Variant 5: 9 counted (1 missing)
      // Variant 12: 12 counted (2 extra found)
      // Remaining 28 variants: exactly 10 counted
      const counts = variants.map((v, idx) => {
        let countedQty = 10;
        if (idx === 4) countedQty = 9;   // Variant 5
        if (idx === 11) countedQty = 12; // Variant 12
        return { variantId: v.id, countedQty };
      });

      const stocktake = await reconcileStocktake(tx, {
        locationId: shopLocId,
        counts,
        notes: 'Monthly Boutique Stocktake'
      });

      assert.strictEqual(stocktake.status, 'APPROVED');
      assert.strictEqual(stocktake.totalCounted, 30);
      assert.strictEqual(stocktake.adjustedCount, 2, 'Exactly 2 variants with discrepancies should have adjustments');

      // Verify adjusted levels match physical count
      const level5 = (await tx.query('stock_levels', l => l.variant_id === variants[4].id && l.location_id === shopLocId))[0];
      const level12 = (await tx.query('stock_levels', l => l.variant_id === variants[11].id && l.location_id === shopLocId))[0];

      assert.strictEqual(level5.on_hand, 9, 'Variant 5 on_hand must be adjusted to 9');
      assert.strictEqual(level12.on_hand, 12, 'Variant 12 on_hand must be adjusted to 12');
    });
  });
});
