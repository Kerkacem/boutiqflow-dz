const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  ORDER_STATUSES,
  createOnlineOrder
} = require('../src/orders/orders');
const { CodConfirmationService, CONFIRMATION_STATUSES } = require('../src/orders/confirmation_service');
const { applyStockMovement, getOrCreateStockLevel, MOVEMENT_REASONS } = require('../src/inventory/ledger');

test('Phase 06 — Reservation Integrity & Cancellation Suite', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let locationId = null;
  let variantId = null;

  await t.test('Setup tenant, location, and test variant stock', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Main Depot', type: 'warehouse' });
      locationId = loc.id;

      const prod = await tx.insert('products', { name: 'Veste Cuir Bomber' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'BMB-CUIR-BRN-XL',
        size: 'XL',
        color: 'Marron',
        cost_price: 500000n,
        sale_price: 950000n
      });
      variantId = v.id;

      // Seed 10 units on hand
      await applyStockMovement(tx, {
        variantId: v.id,
        locationId,
        qty: 10,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });
  });

  await t.test('INV-06-03: Reservation belongs to exactly one Order and Variant context', async () => {
    let orderId = null;
    await db.withTenant({ tenantId }, async (tx) => {
      const order = await createOnlineOrder(tx, {
        customerName: 'Nabil Touati',
        customerPhone: '0555123456',
        items: [{ variantId, qty: 2 }]
      });
      orderId = order.id;

      await CodConfirmationService.confirmAndReserve(tx, { orderId, locationId });

      const reservations = await tx.query('stock_reservations', r => r.order_id === orderId);
      assert.strictEqual(reservations.length, 1);
      assert.strictEqual(reservations[0].order_id, orderId);
      assert.strictEqual(reservations[0].variant_id, variantId);
      assert.strictEqual(reservations[0].qty, 2);
      assert.strictEqual(reservations[0].status, 'ACTIVE');
    });
  });

  await t.test('INV-06-06: Cancellation releases an existing reservation at most once (cancel x 10 test)', async () => {
    let orderId = null;
    await db.withTenant({ tenantId }, async (tx) => {
      // Stock: on_hand = 10, reserved = 2 (from previous test), available = 8
      const order = await createOnlineOrder(tx, {
        customerName: 'Hichem Belkacem',
        customerPhone: '0660223344',
        items: [{ variantId, qty: 5 }]
      });
      orderId = order.id;

      // Confirm -> reserves 5 units (total reserved = 2 + 5 = 7, available = 3)
      await CodConfirmationService.confirmAndReserve(tx, { orderId, locationId });

      const levelAfterConfirm = await getOrCreateStockLevel(tx, variantId, locationId);
      assert.strictEqual(levelAfterConfirm.reserved, 7);
      assert.strictEqual(levelAfterConfirm.available, 3);
    });

    // Execute cancelAndRelease 10 times consecutively
    for (let i = 1; i <= 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await CodConfirmationService.cancelAndRelease(tx, {
          orderId,
          reason: 'Customer cancelled by phone'
        });
        if (i === 1) {
          assert.strictEqual(res.released, true, 'First cancel releases the 5 units');
        } else {
          assert.strictEqual(res.released, false, `Cancel ${i} does not release stock again`);
        }
      });
    }

    // Verify stock state: available restored by exactly 5 units (now 8, NOT 50!)
    await db.withTenant({ tenantId }, async (tx) => {
      const levelAfterCancels = await getOrCreateStockLevel(tx, variantId, locationId);
      assert.strictEqual(levelAfterCancels.on_hand, 10);
      assert.strictEqual(levelAfterCancels.reserved, 2, 'INV-06-06: Reserved stock decremented by 5 exactly once');
      assert.strictEqual(levelAfterCancels.available, 8, 'INV-06-06: Available stock restored to 8 exactly once');

      // Verify order status
      const order = await tx.findById('online_orders', orderId);
      assert.strictEqual(order.status, ORDER_STATUSES.CANCELLED);
    });
  });

  await t.test('INV-06-07: Refused and Expired orders without reservation never mutate inventory', async () => {
    // 1. Refused unconfirmed order
    await db.withTenant({ tenantId }, async (tx) => {
      const movementsBefore = await tx.query('stock_movements');

      const order1 = await createOnlineOrder(tx, {
        customerName: 'Refusal Test',
        customerPhone: '0770112233',
        items: [{ variantId, qty: 3 }]
      });

      const res = await CodConfirmationService.refuseOrder(tx, {
        orderId: order1.id,
        reason: 'Customer refused on phone call'
      });
      assert.strictEqual(res.released, false, 'INV-06-07: Zero reservations to release');

      const movementsAfter = await tx.query('stock_movements');
      assert.strictEqual(movementsAfter.length, movementsBefore.length, 'INV-06-07: Zero stock ledger movements');

      const order = await tx.findById('online_orders', order1.id);
      assert.strictEqual(order.status, ORDER_STATUSES.REFUSED);
    });

    // 2. Expired unconfirmed order
    await db.withTenant({ tenantId }, async (tx) => {
      const movementsBefore = await tx.query('stock_movements');

      const order2 = await createOnlineOrder(tx, {
        customerName: 'Expiry Test',
        customerPhone: '0555112233',
        items: [{ variantId, qty: 2 }]
      });

      const res = await CodConfirmationService.expireOrder(tx, {
        orderId: order2.id,
        timeoutMinutes: 2880
      });
      assert.strictEqual(res.replayed, false);

      const movementsAfter = await tx.query('stock_movements');
      assert.strictEqual(movementsAfter.length, movementsBefore.length, 'INV-06-07: Zero stock ledger movements on expiration');

      const order = await tx.findById('online_orders', order2.id);
      assert.strictEqual(order.status, ORDER_STATUSES.EXPIRED);
    });
  });

  await t.test('Business Integrity Test (Requirement 25): Complete lifecycle cycle verify', async () => {
    const cleanTenant = generateUUIDv7();
    let cleanLocId = null;
    let cleanVarId = null;

    // Initial state: stock = 10, reserved = 0, available = 10
    await db.withTenant({ tenantId: cleanTenant }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Store Central', type: 'shop' });
      cleanLocId = loc.id;

      const prod = await tx.insert('products', { name: 'Manteau Laine' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'MNT-LAIN-42',
        size: '42',
        color: 'Gris',
        cost_price: 800000n,
        sale_price: 1500000n
      });
      cleanVarId = v.id;

      await applyStockMovement(tx, {
        variantId: v.id,
        locationId: cleanLocId,
        qty: 10,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });

    let orderId = null;
    const opId = `CYCLE-ORDER-${Date.now()}`;

    // 1. Order created: stock = 10, reserved = 0, available = 10
    await db.withTenant({ tenantId: cleanTenant }, async (tx) => {
      const order = await createOnlineOrder(tx, {
        customerName: 'Cycle Customer',
        customerPhone: '0550998877',
        items: [{ variantId: cleanVarId, qty: 3 }],
        operationId: opId
      });
      orderId = order.id;

      const lvl = await getOrCreateStockLevel(tx, cleanVarId, cleanLocId);
      assert.strictEqual(lvl.on_hand, 10);
      assert.strictEqual(lvl.reserved, 0);
      assert.strictEqual(lvl.available, 10);
    });

    // 2. Confirmed: stock = 10, reserved = 3, available = 7
    await db.withTenant({ tenantId: cleanTenant }, async (tx) => {
      await CodConfirmationService.confirmAndReserve(tx, {
        orderId,
        locationId: cleanLocId
      });

      const lvl = await getOrCreateStockLevel(tx, cleanVarId, cleanLocId);
      assert.strictEqual(lvl.on_hand, 10);
      assert.strictEqual(lvl.reserved, 3);
      assert.strictEqual(lvl.available, 7);
    });

    // 3. Cancelled: stock = 10, reserved = 0, available = 10
    await db.withTenant({ tenantId: cleanTenant }, async (tx) => {
      await CodConfirmationService.cancelAndRelease(tx, {
        orderId,
        reason: 'Client request'
      });

      const lvl = await getOrCreateStockLevel(tx, cleanVarId, cleanLocId);
      assert.strictEqual(lvl.on_hand, 10);
      assert.strictEqual(lvl.reserved, 0);
      assert.strictEqual(lvl.available, 10);
    });

    // 4. Repeated confirmation attempt on cancelled order must fail!
    await db.withTenant({ tenantId: cleanTenant }, async (tx) => {
      await assert.rejects(
        CodConfirmationService.confirmAndReserve(tx, {
          orderId,
          locationId: cleanLocId
        }),
        /Cannot confirm an order that is in status 'CANCELLED'/
      );

      const lvl = await getOrCreateStockLevel(tx, cleanVarId, cleanLocId);
      assert.strictEqual(lvl.on_hand, 10);
      assert.strictEqual(lvl.reserved, 0);
      assert.strictEqual(lvl.available, 10);
    });
  });
});
