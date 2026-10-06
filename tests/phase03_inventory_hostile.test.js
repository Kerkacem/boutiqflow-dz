const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  receiveStock,
  issueStock,
  adjustStock,
  reserveStock,
  releaseReservation,
  consumeReservation,
  transferStock,
  getVariantStock,
  getStockLedger,
  ADJUSTMENT_REASONS
} = require('../src/inventory/ledger');

test('Phase 03 — Inventory Hostile & Adversarial Test Suite', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let locA, locA2, varA;
  let locB, varB;

  await t.test('Setup isolated tenants, locations, and variants', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Alger A' });
      const loc2 = await tx.insert('inventory_locations', { name: 'Dépôt Alger A' });
      locA = loc.id;
      locA2 = loc2.id;

      const prod = await tx.insert('products', { name: 'Robe Soie A' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'ROB-SOIE-S',
        size: 'S',
        color: 'Rouge',
        cost_price: 250000n,
        sale_price: 500000n
      });
      varA = variant.id;
    });

    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Oran B' });
      locB = loc.id;

      const prod = await tx.insert('products', { name: 'Veste Cuir B' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'VST-CUIR-M',
        size: 'M',
        color: 'Noir',
        cost_price: 400000n,
        sale_price: 800000n
      });
      varB = variant.id;
    });
  });

  await t.test('Hostile: Negative quantity rejected on receive, issue, reserve, and transfer', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => receiveStock(tx, { variantId: varA, locationId: locA, quantity: -5 }),
        /Validation Error: Received stock quantity must be a strictly positive integer/
      );

      await assert.rejects(
        async () => issueStock(tx, { variantId: varA, locationId: locA, quantity: -2 }),
        /Validation Error: Issued stock quantity must be a strictly positive integer/
      );

      await assert.rejects(
        async () => reserveStock(tx, { variantId: varA, locationId: locA, quantity: -3 }),
        /Validation Error: Reservation quantity must be a strictly positive integer/
      );

      await assert.rejects(
        async () => transferStock(tx, { variantId: varA, fromLocationId: locA, toLocationId: locA2, quantity: -4 }),
        /Validation Error: Transfer quantity must be a strictly positive integer/
      );
    });
  });

  await t.test('Hostile: Zero quantity rejected on all mutations', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => receiveStock(tx, { variantId: varA, locationId: locA, quantity: 0 }),
        /Validation Error: Received stock quantity must be a strictly positive integer/
      );

      await assert.rejects(
        async () => issueStock(tx, { variantId: varA, locationId: locA, quantity: 0 }),
        /Validation Error: Issued stock quantity must be a strictly positive integer/
      );

      await assert.rejects(
        async () => reserveStock(tx, { variantId: varA, locationId: locA, quantity: 0 }),
        /Validation Error: Reservation quantity must be a strictly positive integer/
      );

      await assert.rejects(
        async () => adjustStock(tx, { variantId: varA, locationId: locA, adjustment: 0, reason: ADJUSTMENT_REASONS.FOUND }),
        /Validation Error: Stock adjustment delta must be a non-zero integer/
      );

      await assert.rejects(
        async () => transferStock(tx, { variantId: varA, fromLocationId: locA, toLocationId: locA2, quantity: 0 }),
        /Validation Error: Transfer quantity must be a strictly positive integer/
      );
    });
  });

  await t.test('Hostile: Decimal and float quantities rejected (clothing items are discrete integers)', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => receiveStock(tx, { variantId: varA, locationId: locA, quantity: 2.5 }),
        /Validation Error/
      );

      await assert.rejects(
        async () => issueStock(tx, { variantId: varA, locationId: locA, quantity: 1.1 }),
        /Validation Error/
      );

      await assert.rejects(
        async () => adjustStock(tx, { variantId: varA, locationId: locA, adjustment: 3.14, reason: ADJUSTMENT_REASONS.DAMAGED }),
        /Validation Error/
      );

      await assert.rejects(
        async () => reserveStock(tx, { variantId: varA, locationId: locA, quantity: 4.7 }),
        /Validation Error/
      );
    });
  });

  await t.test('Hostile: NaN and infinite quantities rejected', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => receiveStock(tx, { variantId: varA, locationId: locA, quantity: NaN }),
        /Validation Error/
      );

      await assert.rejects(
        async () => receiveStock(tx, { variantId: varA, locationId: locA, quantity: Infinity }),
        /Validation Error/
      );
    });
  });

  await t.test('Hostile: Overselling beyond onHand is blocked by INV-03-01', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Stock is currently 0. Attempt to issue 1 unit.
      await assert.rejects(
        async () => issueStock(tx, { variantId: varA, locationId: locA, quantity: 1 }),
        /Invariant Violation INV-03-01: Insufficient inventory/
      );

      const stock = await getVariantStock(tx, varA, locA);
      assert.strictEqual(stock.onHand, 0);
      assert.strictEqual(stock.available, 0);
    });
  });

  await t.test('Hostile: Over-reserving beyond available is blocked by INV-03-04', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Receive 5 units
      await receiveStock(tx, { variantId: varA, locationId: locA, quantity: 5 });

      // Attempt to reserve 6 units
      await assert.rejects(
        async () => reserveStock(tx, { variantId: varA, locationId: locA, quantity: 6 }),
        /Cannot reserve: requested 6 but available is only 5/
      );

      const stock = await getVariantStock(tx, varA, locA);
      assert.strictEqual(stock.onHand, 5);
      assert.strictEqual(stock.reserved, 0);
      assert.strictEqual(stock.available, 5);
    });
  });

  await t.test('Hostile: Invalid stock adjustment reasons rejected', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => adjustStock(tx, { variantId: varA, locationId: locA, adjustment: 2, reason: 'MAGIC_FOUND' }),
        /Validation Error: Invalid stock adjustment reason 'MAGIC_FOUND'/
      );

      await assert.rejects(
        async () => adjustStock(tx, { variantId: varA, locationId: locA, adjustment: -1, reason: 'STOLEN' }),
        /Validation Error: Invalid stock adjustment reason 'STOLEN'/
      );
    });
  });

  await t.test('Hostile: Stock adjustment driving onHand negative is rejected', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // onHand is 5. Attempt adjustment of -10
      await assert.rejects(
        async () => adjustStock(tx, { variantId: varA, locationId: locA, adjustment: -10, reason: ADJUSTMENT_REASONS.LOST }),
        /Invariant Violation INV-03-01: Insufficient inventory/
      );

      const stock = await getVariantStock(tx, varA, locA);
      assert.strictEqual(stock.onHand, 5);
    });
  });

  await t.test('Hostile & Isolation: Tenant A cannot access Tenant B variant or location (INV-03-11)', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 1. Tenant A trying to receive stock for Tenant B variant
      await assert.rejects(
        async () => receiveStock(tx, { variantId: varB, locationId: locA, quantity: 10 }),
        /Tenant Isolation Violation: Variant .* not found or belongs to another tenant/
      );

      // 2. Tenant A trying to issue stock for Tenant B variant
      await assert.rejects(
        async () => issueStock(tx, { variantId: varB, locationId: locA, quantity: 1 }),
        /Tenant Isolation Violation: Variant .* not found or belongs to another tenant/
      );

      // 3. Tenant A trying to use Tenant B location
      await assert.rejects(
        async () => receiveStock(tx, { variantId: varA, locationId: locB, quantity: 10 }),
        /Tenant Isolation Violation: Location .* not found or belongs to another tenant/
      );

      // 4. Tenant A trying to reserve Tenant B variant
      await assert.rejects(
        async () => reserveStock(tx, { variantId: varB, locationId: locA, quantity: 1 }),
        /Tenant Isolation Violation: Variant .* not found or belongs to another tenant/
      );

      // 5. Tenant A trying to adjust Tenant B variant
      await assert.rejects(
        async () => adjustStock(tx, { variantId: varB, locationId: locA, adjustment: 1, reason: ADJUSTMENT_REASONS.FOUND }),
        /Tenant Isolation Violation: Variant .* not found or belongs to another tenant/
      );

      // 6. Tenant A trying to transfer Tenant B variant
      await assert.rejects(
        async () => transferStock(tx, { variantId: varB, fromLocationId: locA, toLocationId: locA2, quantity: 1 }),
        /Tenant Isolation Violation: Variant .* not found or belongs to another tenant/
      );

      // 7. Tenant A trying to transfer into Tenant B location
      await assert.rejects(
        async () => transferStock(tx, { variantId: varA, fromLocationId: locA, toLocationId: locB, quantity: 1 }),
        /Tenant Isolation Violation: Location .* not found or belongs to another tenant/
      );
    });
  });

  await t.test('Hostile: Tenant A cannot release or consume Tenant B reservation (INV-03-11)', async () => {
    let resBId;
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      await receiveStock(tx, { variantId: varB, locationId: locB, quantity: 10 });
      const res = await reserveStock(tx, { variantId: varB, locationId: locB, quantity: 2 });
      resBId = res.id;
    });

    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => releaseReservation(tx, resBId),
        /Tenant Isolation Violation: Reservation .* not found or belongs to another tenant/
      );

      await assert.rejects(
        async () => consumeReservation(tx, resBId),
        /Tenant Isolation Violation: Reservation .* not found or belongs to another tenant/
      );
    });
  });

  await t.test('Hostile & Integrity: Stock movements ledger is strictly immutable (INV-03-06)', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const ledger = await getStockLedger(tx, { variantId: varA });
      assert.ok(ledger.length > 0);
      const movementId = ledger[0].id;

      // Direct update attempt on stock_movements must be rejected at DB layer
      await assert.rejects(
        async () => tx.update('stock_movements', movementId, { qty: 9999 }),
        /Ledger Violation: stock_movements are strictly immutable \(INV-03-06\)/
      );

      // Direct delete attempt on stock_movements must be rejected at DB layer
      await assert.rejects(
        async () => tx.delete('stock_movements', movementId),
        /Ledger Violation: stock_movements are strictly immutable \(INV-03-06\)/
      );
    });
  });

  await t.test('Hostile: Transaction atomicity: Failure leaves NO partial stock mutation (INV-03-14)', async () => {
    let stockBefore;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      stockBefore = await getVariantStock(tx, varA, locA);
    });

    // Run a transaction that mutates stock then throws an unexpected database error
    await assert.rejects(async () => {
      await db.withTenant({ tenantId: tenantA }, async (tx) => {
        // Step 1: Receive 100 pieces
        await receiveStock(tx, { variantId: varA, locationId: locA, quantity: 100 });

        // Step 2: Mid-transaction unexpected crash
        throw new Error('Database Connection Dropped Mid-Flight');
      });
    }, /Database Connection Dropped Mid-Flight/);

    // Verify stock is identical to before the crashed transaction
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const stockAfter = await getVariantStock(tx, varA, locA);
      assert.strictEqual(stockAfter.onHand, stockBefore.onHand, 'Atomic Rollback: onHand must be unchanged');
      assert.strictEqual(stockAfter.reserved, stockBefore.reserved, 'Atomic Rollback: reserved must be unchanged');
      assert.strictEqual(stockAfter.available, stockBefore.available, 'Atomic Rollback: available must be unchanged');
    });
  });
});
