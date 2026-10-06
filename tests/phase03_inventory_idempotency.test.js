const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  receiveStock,
  issueStock,
  reserveStock,
  releaseReservation,
  consumeReservation,
  getVariantStock,
  getStockLedger,
  MOVEMENT_TYPES,
  RESERVATION_STATUSES
} = require('../src/inventory/ledger');

test('Phase 03 — Inventory Idempotency & Replay Protection Suite (INV-03-07, 08, 09)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let locationId;
  let variantId;

  await t.test('Setup tenant, location, and test variant', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Alger Idempotency' });
      locationId = loc.id;

      const p = await tx.insert('products', { name: 'Costume Cérémonie' });
      const v = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'CST-CER-BLK-50',
        size: '50',
        color: 'Noir',
        cost_price: 1800000n,
        sale_price: 3500000n
      });
      variantId = v.id;

      // Seed initial stock of 10 units
      await receiveStock(tx, { variantId, locationId, quantity: 10 });
    });
  });

  await t.test('INV-03-09: Mandatory Test: same operationId x 10 requests for issueStock', async () => {
    const fixedOperationId = `SALE-IDEMPOTENT-${generateUUIDv7()}`;
    const responses = [];

    // Simulate 10 duplicate requests (network timeout, retry, browser refresh)
    for (let i = 0; i < 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await issueStock(tx, {
          variantId,
          locationId,
          quantity: 2,
          operationId: fixedOperationId,
          metadata: { attempt: i }
        });
        responses.push(res);
      });
    }

    // Invariant verifications:
    // 1. All 10 requests receive identical response
    assert.strictEqual(responses.length, 10);
    const firstMovementId = responses[0].movementId;
    for (const r of responses) {
      assert.strictEqual(r.movementId, firstMovementId);
      assert.strictEqual(r.onHand, 8);
    }

    // 2. Exactly 1 mutation, 1 ledger event, 0 duplicates
    await db.withTenant({ tenantId }, async (tx) => {
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 8, 'onHand must be 10 - 2 = 8, not 10 - 20 = -10');
      assert.strictEqual(stock.available, 8);

      const ledger = await getStockLedger(tx, { variantId, locationId });
      const saleMovements = ledger.filter(m => m.operation_id === fixedOperationId);
      assert.strictEqual(saleMovements.length, 1, 'Exactly ONE ledger movement recorded for operationId');
      assert.strictEqual(saleMovements[0].quantity, -2);
    });
  });

  await t.test('INV-03-09: same operationId x 10 requests for receiveStock', async () => {
    const fixedOperationId = `RECV-IDEMPOTENT-${generateUUIDv7()}`;
    const responses = [];

    for (let i = 0; i < 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await receiveStock(tx, {
          variantId,
          locationId,
          quantity: 5,
          unitCostCentimes: 1800000n,
          operationId: fixedOperationId
        });
        responses.push(res);
      });
    }

    assert.strictEqual(responses.length, 10);
    for (const r of responses) {
      assert.strictEqual(r.onHand, 13);
    }

    await db.withTenant({ tenantId }, async (tx) => {
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 13, 'Stock must be 8 + 5 = 13 (not 8 + 50 = 58)');

      const ledger = await getStockLedger(tx, { variantId, locationId });
      const recvMovements = ledger.filter(m => m.operation_id === fixedOperationId);
      assert.strictEqual(recvMovements.length, 1, 'Exactly ONE receipt ledger movement');
    });
  });

  await t.test('INV-03-09: same operationId x 10 requests for reserveStock', async () => {
    const fixedOperationId = `RES-IDEMPOTENT-${generateUUIDv7()}`;
    const responses = [];

    for (let i = 0; i < 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await reserveStock(tx, {
          variantId,
          locationId,
          quantity: 3,
          operationId: fixedOperationId,
          orderId: 'ORDER-ONLINE-999'
        });
        responses.push(res);
      });
    }

    assert.strictEqual(responses.length, 10);
    const reservationId = responses[0].id;
    for (const r of responses) {
      assert.strictEqual(r.id, reservationId, 'Same reservation ID returned across all 10 calls');
      assert.strictEqual(r.reserved, 3);
      assert.strictEqual(r.available, 10);
    }

    await db.withTenant({ tenantId }, async (tx) => {
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 13, 'onHand unchanged on reservation');
      assert.strictEqual(stock.reserved, 3, 'reserved must be 3, not 30');
      assert.strictEqual(stock.available, 10, 'available must be 13 - 3 = 10');

      const allReservations = await tx.query('stock_reservations', r => r.operation_id === fixedOperationId);
      assert.strictEqual(allReservations.length, 1, 'Exactly ONE reservation row created in database');
    });
  });

  await t.test('INV-03-07: Reservation release is idempotent (double release does not double-decrement)', async () => {
    let resId;
    await db.withTenant({ tenantId }, async (tx) => {
      const res = await reserveStock(tx, {
        variantId,
        locationId,
        quantity: 2,
        orderId: 'ORDER-RELEASE-TEST'
      });
      resId = res.id;

      const stockBefore = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stockBefore.reserved, 5, '3 + 2 = 5 reserved');
    });

    // Release 1: first release
    await db.withTenant({ tenantId }, async (tx) => {
      const release1 = await releaseReservation(tx, resId);
      assert.strictEqual(release1.status, RESERVATION_STATUSES.RELEASED);
      assert.strictEqual(release1.reserved, 3);

      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.reserved, 3);
      assert.strictEqual(stock.available, 10);
    });

    // Release 2, 3, 4: multiple subsequent releases of the same reservation
    for (let i = 2; i <= 5; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const releaseAgain = await releaseReservation(tx, resId);
        assert.strictEqual(releaseAgain.released, true);
        assert.strictEqual(releaseAgain.idempotent, true);

        // Crucial invariant: reserved does NOT decrement again!
        const stock = await getVariantStock(tx, variantId, locationId);
        assert.strictEqual(stock.reserved, 3, 'INV-03-07: reserved must not decrement below 3 on duplicate release');
        assert.strictEqual(stock.available, 10);
      });
    }
  });

  await t.test('INV-03-08: Reservation consumption is idempotent (double consume does not double-decrement)', async () => {
    let resId;
    await db.withTenant({ tenantId }, async (tx) => {
      // Create a clean new reservation of 2 units
      const res = await reserveStock(tx, {
        variantId,
        locationId,
        quantity: 2,
        orderId: 'ORDER-CONSUME-TEST'
      });
      resId = res.id;

      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 13);
      assert.strictEqual(stock.reserved, 5); // 3 existing + 2 new
      assert.strictEqual(stock.available, 8);
    });

    // Consume 1: first consumption on shipment
    await db.withTenant({ tenantId }, async (tx) => {
      const consume1 = await consumeReservation(tx, resId);
      assert.strictEqual(consume1.status, RESERVATION_STATUSES.CONSUMED);
      assert.strictEqual(consume1.onHand, 11); // 13 - 2
      assert.strictEqual(consume1.reserved, 3); // 5 - 2
      assert.strictEqual(consume1.available, 8); // 11 - 3
    });

    // Consume 2, 3, 4: multiple subsequent consumptions of the same reservation
    for (let i = 2; i <= 5; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const consumeAgain = await consumeReservation(tx, resId);
        assert.strictEqual(consumeAgain.consumed, true);
        assert.strictEqual(consumeAgain.idempotent, true);

        // Crucial invariant: onHand and reserved do NOT decrement again!
        const stock = await getVariantStock(tx, variantId, locationId);
        assert.strictEqual(stock.onHand, 11, 'INV-03-08: onHand must remain 11 on duplicate consumption');
        assert.strictEqual(stock.reserved, 3, 'INV-03-08: reserved must remain 3 on duplicate consumption');
        assert.strictEqual(stock.available, 8);
      });
    }
  });

  await t.test('Webhook-like rapid retry: 10 concurrent requests with same operationId', async () => {
    const concurrentOpId = `WEBHOOK-REPLAY-${generateUUIDv7()}`;

    // Launch 10 simultaneous identical requests
    const attempts = Array.from({ length: 10 }, () => {
      return db.withTenant({ tenantId }, async (tx) => {
        return await issueStock(tx, {
          variantId,
          locationId,
          quantity: 1,
          operationId: concurrentOpId
        });
      });
    });

    const results = await Promise.allSettled(attempts);
    const successes = results.filter(r => r.status === 'fulfilled');
    assert.strictEqual(successes.length, 10, 'All 10 calls succeed returning the idempotent response');

    await db.withTenant({ tenantId }, async (tx) => {
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 10, 'Stock decrements by exactly 1 unit (11 - 1 = 10)');

      const ledger = await getStockLedger(tx, { variantId, locationId });
      const matchingMovements = ledger.filter(m => m.operation_id === concurrentOpId);
      assert.strictEqual(matchingMovements.length, 1, 'Ledger has exactly 1 movement recorded');
    });
  });
});
