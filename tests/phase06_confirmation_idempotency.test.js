const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  ORDER_STATUSES,
  createOnlineOrder
} = require('../src/orders/orders');
const { CodConfirmationService } = require('../src/orders/confirmation_service');
const { applyStockMovement, getOrCreateStockLevel, MOVEMENT_REASONS } = require('../src/inventory/ledger');

test('Phase 06 — Order & Confirmation Idempotency Suite (INV-06-04, INV-06-05)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let locationId = null;
  let variantId = null;

  await t.test('Setup tenant, location, variant, and initial stock', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Main Depot', type: 'warehouse' });
      locationId = loc.id;

      const prod = await tx.insert('products', { name: 'Blouson Cuir' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'BLS-CUIR-BLK-M',
        size: 'M',
        color: 'Noir',
        cost_price: 400000n,
        sale_price: 800000n
      });
      variantId = v.id;

      // Seed 20 units
      await applyStockMovement(tx, {
        variantId: v.id,
        locationId,
        qty: 20,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });
  });

  await t.test('INV-06-04: Sequential duplicate order creation (20x same operationId)', async () => {
    const orderOpId = `ORDER-CREATE-OP-${Date.now()}`;
    const orders = [];

    for (let i = 1; i <= 20; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const order = await createOnlineOrder(tx, {
          customerName: 'Karim Boukhalfa',
          customerPhone: '0550123456',
          wilaya: '16 - Alger',
          commune: 'El Biar',
          address: 'Place Kennedy',
          items: [{ variantId, qty: 2, unitPriceCentimes: 800000n }],
          operationId: orderOpId
        });
        orders.push(order);
      });
    }

    assert.strictEqual(orders.length, 20);
    // Every call returned the exact same order ID
    for (let i = 1; i < 20; i++) {
      assert.strictEqual(orders[i].id, orders[0].id, `Iteration ${i + 1} returned same order ID`);
    }

    await db.withTenant({ tenantId }, async (tx) => {
      // Exactly 1 order in database
      const allOrders = await tx.query('online_orders', o => o.operation_id === orderOpId);
      assert.strictEqual(allOrders.length, 1, 'INV-06-04: Exactly 1 order created in database');

      // Zero reservations created
      const reservations = await tx.query('stock_reservations', r => r.order_id === orders[0].id);
      assert.strictEqual(reservations.length, 0, 'INV-06-01: Zero stock reservations on order creation');
    });
  });

  await t.test('INV-06-05: Sequential duplicate confirmation (10x same order)', async () => {
    let orderId = null;
    await db.withTenant({ tenantId }, async (tx) => {
      const order = await createOnlineOrder(tx, {
        customerName: 'Walid Saadi',
        customerPhone: '0661223344',
        items: [{ variantId, qty: 3, unitPriceCentimes: 800000n }]
      });
      orderId = order.id;
    });

    const confirmOpId = `CONFIRM-OP-${Date.now()}`;
    const results = [];

    // Confirm the order 10 times consecutively
    for (let i = 1; i <= 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await CodConfirmationService.confirmAndReserve(tx, {
          orderId,
          locationId,
          operationId: confirmOpId
        });
        results.push(res);
      });
    }

    assert.strictEqual(results.length, 10);
    assert.strictEqual(results[0].replayed, false, 'First confirmation was freshly executed');
    for (let i = 1; i < 10; i++) {
      assert.strictEqual(results[i].replayed, true, `Call ${i + 1} detected as duplicate replay`);
      assert.strictEqual(results[i].status, 'CONFIRMED');
    }

    // Verify inventory reserved exactly 3 units (NOT 30 units)
    await db.withTenant({ tenantId }, async (tx) => {
      const reservations = await tx.query('stock_reservations', r => r.order_id === orderId && r.status === 'ACTIVE');
      assert.strictEqual(reservations.length, 1, 'INV-06-05: Exactly 1 stock reservation active');
      assert.strictEqual(reservations[0].qty, 3, 'Reserved quantity is strictly 3');

      const level = await getOrCreateStockLevel(tx, variantId, locationId);
      assert.strictEqual(level.reserved, 3, 'Total reserved is strictly 3');
      assert.strictEqual(level.available, 17, 'Available is strictly 17 (20 - 3)');
    });
  });

  await t.test('CRITICAL DECISIVE TEST (Requirement 28): 100 concurrent confirmations on same order with same operationId', async () => {
    let targetOrderId = null;

    await db.withTenant({ tenantId }, async (tx) => {
      const order = await createOnlineOrder(tx, {
        customerName: 'Decisive Concurrent Customer',
        customerPhone: '0770998877',
        items: [{ variantId, qty: 4, unitPriceCentimes: 800000n }]
      });
      targetOrderId = order.id;
    });

    const opId = `DECISIVE-CONCURRENT-CONFIRM-${Date.now()}`;

    // Execute 100 concurrent confirmation requests simultaneously
    const tasks = Array.from({ length: 100 }, (_, i) => {
      return db.withTenant({ tenantId }, async (tx) => {
        return await CodConfirmationService.confirmAndReserve(tx, {
          orderId: targetOrderId,
          locationId,
          agentId: `worker-${i}`,
          operationId: opId
        });
      });
    });

    const results = await Promise.all(tasks);
    assert.strictEqual(results.length, 100);

    // Verify all returned CONFIRMED
    for (const r of results) {
      assert.strictEqual(r.status, 'CONFIRMED');
    }

    // Exactly 1 was freshly processed, 99 were replayed
    const freshCount = results.filter(r => r.replayed === false).length;
    const replayedCount = results.filter(r => r.replayed === true).length;
    assert.strictEqual(freshCount, 1, 'Requirement 28: Exactly 1 confirmation freshly executed');
    assert.strictEqual(replayedCount, 99, 'Requirement 28: Exactly 99 requests safely replayed');

    // Verify database state:
    await db.withTenant({ tenantId }, async (tx) => {
      const reservations = await tx.query('stock_reservations', r => r.order_id === targetOrderId && r.status === 'ACTIVE');
      assert.strictEqual(reservations.length, 1, 'Requirement 28: Exactly 1 stock reservation created');
      assert.strictEqual(reservations[0].qty, 4, 'Reserved quantity is strictly 4');

      // Zero negative stock, available strictly decremented once
      const level = await getOrCreateStockLevel(tx, variantId, locationId);
      assert.strictEqual(level.on_hand, 20);
      assert.strictEqual(level.reserved, 7); // 3 from previous subtest + 4 from this subtest
      assert.strictEqual(level.available, 13); // 20 - 7 = 13
    });
  });
});
