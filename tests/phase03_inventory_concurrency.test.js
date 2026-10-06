const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  receiveStock,
  issueStock,
  reserveStock,
  getVariantStock,
  getStockLedger,
  MOVEMENT_TYPES
} = require('../src/inventory/ledger');

test('Phase 03 — Inventory Concurrency & Race Condition Suite (INV-03-10)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let locationId;

  await t.test('Setup tenant and location', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Alger Concurrency' });
      locationId = loc.id;
    });
  });

  await t.test('Concurrency 1: Initial stock = 1, 2 concurrent sales -> 1 succeeds, 1 fails', async () => {
    let variantId;
    await db.withTenant({ tenantId }, async (tx) => {
      const p = await tx.insert('products', { name: 'Jupe Plissée' });
      const v = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'JUP-PLIS-38',
        size: '38',
        color: 'Noir',
        cost_price: 150000n,
        sale_price: 350000n
      });
      variantId = v.id;

      // Seed exactly 1 unit
      await receiveStock(tx, { variantId, locationId, quantity: 1 });
    });

    // Launch Sale A and Sale B concurrently in separate transactions
    const attemptSale = async (label) => {
      return db.withTenant({ tenantId }, async (tx) => {
        return await issueStock(tx, {
          variantId,
          locationId,
          quantity: 1,
          operationId: `sale-${label}-${generateUUIDv7()}`,
          metadata: { label }
        });
      });
    };

    const results = await Promise.allSettled([
      attemptSale('Sale-A'),
      attemptSale('Sale-B')
    ]);

    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');

    assert.strictEqual(successes.length, 1, 'Exactly one concurrent sale must succeed');
    assert.strictEqual(failures.length, 1, 'Exactly one concurrent sale must fail');
    assert.match(failures[0].reason.message, /Invariant Violation INV-03-01: Insufficient inventory/);

    await db.withTenant({ tenantId }, async (tx) => {
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 0, 'Final onHand must be strictly 0');
      assert.strictEqual(stock.reserved, 0, 'Final reserved must be strictly 0');
      assert.strictEqual(stock.available, 0, 'Final available must be strictly 0');
    });
  });

  await t.test('GATE 03 DECISIVE TEST: Stock = 1, 100 concurrent sale attempts', async () => {
    let variantId;
    await db.withTenant({ tenantId }, async (tx) => {
      const p = await tx.insert('products', { name: 'Blouson Édition Limitée' });
      const v = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'BLS-ED-LTD-1',
        size: 'Unique',
        color: 'Argent',
        cost_price: 500000n,
        sale_price: 1200000n
      });
      variantId = v.id;

      // Initial Stock = 1
      await receiveStock(tx, { variantId, locationId, quantity: 1 });
    });

    // 100 concurrent sale attempts
    const attempts = Array.from({ length: 100 }, (_, idx) => {
      return db.withTenant({ tenantId }, async (tx) => {
        return await issueStock(tx, {
          variantId,
          locationId,
          quantity: 1,
          operationId: `attempt-sale-${idx}-${generateUUIDv7()}`
        });
      });
    });

    const results = await Promise.allSettled(attempts);
    const successfulSales = results.filter(r => r.status === 'fulfilled');
    const failedSales = results.filter(r => r.status === 'rejected');

    // Verification of Gate 03 Requirements:
    // SUCCESSFUL SALES = 1
    // FAILED SALES = 99
    // FINAL ON_HAND = 0
    // NEGATIVE STOCK = 0
    // DUPLICATE LEDGER = 0
    assert.strictEqual(successfulSales.length, 1, 'SUCCESSFUL SALES = 1');
    assert.strictEqual(failedSales.length, 99, 'FAILED SALES = 99');

    await db.withTenant({ tenantId }, async (tx) => {
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 0, 'FINAL ON_HAND = 0');
      assert.strictEqual(stock.reserved, 0, 'FINAL RESERVED = 0');
      assert.strictEqual(stock.available, 0, 'NEGATIVE STOCK = 0');

      const ledger = await getStockLedger(tx, { variantId, locationId });
      const saleMovements = ledger.filter(m => m.type === MOVEMENT_TYPES.SALE);
      assert.strictEqual(saleMovements.length, 1, 'DUPLICATE LEDGER = 0 (exactly 1 sale movement)');
    });
  });

  await t.test('High-Load Scale Test: Stock = 10, 100 concurrent sale attempts', async () => {
    let variantId;
    await db.withTenant({ tenantId }, async (tx) => {
      const p = await tx.insert('products', { name: 'Polo Piqué Algérien' });
      const v = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'POL-PIQ-WHT-M',
        size: 'M',
        color: 'Blanc',
        cost_price: 120000n,
        sale_price: 260000n
      });
      variantId = v.id;

      // Seed 10 units
      await receiveStock(tx, { variantId, locationId, quantity: 10 });
    });

    const attempts = Array.from({ length: 100 }, (_, idx) => {
      return db.withTenant({ tenantId }, async (tx) => {
        return await issueStock(tx, {
          variantId,
          locationId,
          quantity: 1,
          operationId: `scale-sale-${idx}-${generateUUIDv7()}`
        });
      });
    });

    const results = await Promise.allSettled(attempts);
    const successfulSales = results.filter(r => r.status === 'fulfilled');
    const failedSales = results.filter(r => r.status === 'rejected');

    assert.strictEqual(successfulSales.length, 10, 'Exactly 10 sales must succeed out of 100');
    assert.strictEqual(failedSales.length, 90, 'Exactly 90 sales must fail');

    await db.withTenant({ tenantId }, async (tx) => {
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 0, 'Final onHand must be exactly 0');
      assert.strictEqual(stock.reserved, 0, 'Final reserved must be exactly 0');
      assert.strictEqual(stock.available, 0, 'Final available must be exactly 0');

      const ledger = await getStockLedger(tx, { variantId, locationId });
      const saleMovements = ledger.filter(m => m.type === MOVEMENT_TYPES.SALE);
      assert.strictEqual(saleMovements.length, 10, 'Ledger must contain exactly 10 sale records');
    });
  });

  await t.test('Concurrent Reservations: Stock = 5, 50 concurrent reservation attempts', async () => {
    let variantId;
    await db.withTenant({ tenantId }, async (tx) => {
      const p = await tx.insert('products', { name: 'Pantalon Lin Été' });
      const v = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'PNT-LIN-BEI-40',
        size: '40',
        color: 'Beige',
        cost_price: 200000n,
        sale_price: 420000n
      });
      variantId = v.id;

      await receiveStock(tx, { variantId, locationId, quantity: 5 });
    });

    const attempts = Array.from({ length: 50 }, (_, idx) => {
      return db.withTenant({ tenantId }, async (tx) => {
        return await reserveStock(tx, {
          variantId,
          locationId,
          quantity: 1,
          orderId: `order-race-${idx}`,
          operationId: `op-res-race-${idx}-${generateUUIDv7()}`
        });
      });
    });

    const results = await Promise.allSettled(attempts);
    const successfulRes = results.filter(r => r.status === 'fulfilled');
    const failedRes = results.filter(r => r.status === 'rejected');

    assert.strictEqual(successfulRes.length, 5, 'Exactly 5 reservations must succeed');
    assert.strictEqual(failedRes.length, 45, 'Remaining 45 reservations must fail');

    await db.withTenant({ tenantId }, async (tx) => {
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 5, 'onHand must remain 5 during reservations');
      assert.strictEqual(stock.reserved, 5, 'reserved must be 5');
      assert.strictEqual(stock.available, 0, 'available must be 0');
    });
  });

  await t.test('Mixed Concurrency Race: 2 Sales vs 2 Reservations for 2 units total', async () => {
    let variantId;
    await db.withTenant({ tenantId }, async (tx) => {
      const p = await tx.insert('products', { name: 'Casquette Coton' });
      const v = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'CSQ-COT-NVY',
        size: 'TU',
        color: 'Bleu Marine',
        cost_price: 80000n,
        sale_price: 180000n
      });
      variantId = v.id;

      await receiveStock(tx, { variantId, locationId, quantity: 2 });
    });

    const mixedAttempts = [
      db.withTenant({ tenantId }, tx => issueStock(tx, { variantId, locationId, quantity: 1, operationId: 'sale-race-1' })),
      db.withTenant({ tenantId }, tx => reserveStock(tx, { variantId, locationId, quantity: 1, operationId: 'res-race-1' })),
      db.withTenant({ tenantId }, tx => issueStock(tx, { variantId, locationId, quantity: 1, operationId: 'sale-race-2' })),
      db.withTenant({ tenantId }, tx => reserveStock(tx, { variantId, locationId, quantity: 1, operationId: 'res-race-2' }))
    ];

    const results = await Promise.allSettled(mixedAttempts);
    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');

    assert.strictEqual(successes.length, 2, 'Exactly 2 mixed operations must succeed');
    assert.strictEqual(failures.length, 2, 'Exactly 2 mixed operations must fail');

    await db.withTenant({ tenantId }, async (tx) => {
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.available, 0, 'Available stock must be 0 (all consumed or reserved)');
      assert.ok(stock.onHand >= 0, 'onHand >= 0');
      assert.ok(stock.reserved >= 0, 'reserved >= 0');
      assert.ok(stock.reserved <= stock.onHand, 'reserved <= onHand');
    });
  });
});
