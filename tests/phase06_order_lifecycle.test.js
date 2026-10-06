const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  ORDER_STATUSES,
  createOnlineOrder,
  transitionOrderStatus,
  shipOrder,
  deliverOrder,
  receiveReturnedOrder
} = require('../src/orders/orders');
const { CodConfirmationService } = require('../src/orders/confirmation_service');
const { applyStockMovement, getOrCreateStockLevel, MOVEMENT_REASONS } = require('../src/inventory/ledger');

test('Phase 06 — Online Order Lifecycle & State Machine Suite', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let warehouseLocationId = null;
  let shopLocationId = null;
  let variantId = null;

  await t.test('Setup tenant, locations, product variant, and initial stock', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const wh = await tx.insert('inventory_locations', { name: 'Algiers Dispatch Hub', type: 'warehouse' });
      const shop = await tx.insert('inventory_locations', { name: 'Didouche Store', type: 'shop' });
      warehouseLocationId = wh.id;
      shopLocationId = shop.id;

      const prod = await tx.insert('products', { name: 'Karakou Moderne Algerois' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'KRK-MOD-GLD-38',
        size: '38',
        color: 'Doré',
        cost_price: 1500000n, // 15,000 DA
        sale_price: 2800000n  // 28,000 DA
      });
      variantId = v.id;

      // Seed 10 units in warehouse
      await applyStockMovement(tx, {
        variantId: v.id,
        locationId: warehouseLocationId,
        qty: 10,
        costPriceCentimes: 1500000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });
  });

  await t.test('INV-06-01: Order creation starts as NEW and does NOT reserve inventory', async () => {
    let orderId = null;
    await db.withTenant({ tenantId }, async (tx) => {
      const levelBefore = await getOrCreateStockLevel(tx, variantId, warehouseLocationId);
      assert.strictEqual(levelBefore.on_hand, 10);
      assert.strictEqual(levelBefore.reserved, 0);
      assert.strictEqual(levelBefore.available, 10);

      const order = await createOnlineOrder(tx, {
        customerName: 'Meriem Haddad',
        customerPhone: '0550112233',
        wilaya: '16 - Alger',
        commune: 'Hydra',
        address: 'Rue Djenane El Malik',
        source: 'INSTAGRAM',
        deliveryFeeCentimes: 60000n, // 600 DA
        items: [{ variantId, qty: 2, unitPriceCentimes: 2800000n }]
      });

      orderId = order.id;
      assert.strictEqual(order.status, ORDER_STATUSES.NEW);
      assert.strictEqual(order.subtotal_centimes, 5600000n);
      assert.strictEqual(order.delivery_fee_centimes, 60000n);
      assert.strictEqual(order.total_centimes, 5660000n);
      assert.strictEqual(order.cod_amount_centimes, 5660000n);

      // Verify stock level is completely untouched (INV-06-01)
      const levelAfter = await getOrCreateStockLevel(tx, variantId, warehouseLocationId);
      assert.strictEqual(levelAfter.on_hand, 10, 'INV-06-01: on_hand unchanged');
      assert.strictEqual(levelAfter.reserved, 0, 'INV-06-01: reserved must be 0 upon order creation');
      assert.strictEqual(levelAfter.available, 10, 'INV-06-01: available must remain 10');
    });
  });

  await t.test('Happy path: NEW -> CONFIRMED -> RESERVED -> PREPARING -> READY_TO_SHIP -> SHIPPED -> DELIVERED', async () => {
    let orderId = null;
    await db.withTenant({ tenantId }, async (tx) => {
      const order = await createOnlineOrder(tx, {
        customerName: 'Lina Benali',
        customerPhone: '0661998877',
        wilaya: '31 - Oran',
        commune: 'Akid Lotfi',
        address: 'Residence El Bahia',
        source: 'STOREFRONT',
        deliveryFeeCentimes: 70000n,
        items: [{ variantId, qty: 1, unitPriceCentimes: 2800000n }]
      });
      orderId = order.id;
    });

    // 1. Confirm & Reserve
    await db.withTenant({ tenantId }, async (tx) => {
      const confRes = await CodConfirmationService.confirmAndReserve(tx, {
        orderId,
        locationId: warehouseLocationId,
        agentId: generateUUIDv7()
      });
      assert.strictEqual(confRes.status, 'CONFIRMED');

      const level = await getOrCreateStockLevel(tx, variantId, warehouseLocationId);
      assert.strictEqual(level.on_hand, 10);
      assert.strictEqual(level.reserved, 1);
      assert.strictEqual(level.available, 9);
    });

    // 2. Transition CONFIRMED -> PREPARING -> READY_TO_SHIP
    await db.withTenant({ tenantId }, async (tx) => {
      await transitionOrderStatus(tx, orderId, ORDER_STATUSES.PREPARING);
      let order = await tx.findById('online_orders', orderId);
      assert.strictEqual(order.status, ORDER_STATUSES.PREPARING);

      await transitionOrderStatus(tx, orderId, ORDER_STATUSES.READY_TO_SHIP);
      order = await tx.findById('online_orders', orderId);
      assert.strictEqual(order.status, ORDER_STATUSES.READY_TO_SHIP);
    });

    // 3. Mock courier shipping: READY_TO_SHIP -> SHIPPED (deducts stock and fulfills reservation)
    const mockCourier = {
      accountId: generateUUIDv7(),
      createShipment: async () => ({
        trackingCode: 'YAL-ALG-998811',
        shippingCostCentimes: 45000n,
        codAmountCentimes: 2870000n,
        labelUrl: 'https://yalidine.app/labels/998811.pdf'
      })
    };

    await db.withTenant({ tenantId }, async (tx) => {
      await shipOrder(tx, { orderId, courierAdapter: mockCourier });
      const order = await tx.findById('online_orders', orderId);
      assert.strictEqual(order.status, ORDER_STATUSES.SHIPPED);

      const level = await getOrCreateStockLevel(tx, variantId, warehouseLocationId);
      assert.strictEqual(level.on_hand, 9, 'Stock decremented to 9 on ship');
      assert.strictEqual(level.reserved, 0, 'Reservation fulfilled');
      assert.strictEqual(level.available, 9);
    });

    // 4. SHIPPED -> DELIVERED
    await db.withTenant({ tenantId }, async (tx) => {
      await deliverOrder(tx, orderId);
      const order = await tx.findById('online_orders', orderId);
      assert.strictEqual(order.status, ORDER_STATUSES.DELIVERED);
    });
  });

  await t.test('State Machine: Prohibited transitions are strictly rejected', async () => {
    let orderId = null;
    await db.withTenant({ tenantId }, async (tx) => {
      const order = await createOnlineOrder(tx, {
        customerName: 'Samir Brahimi',
        customerPhone: '0770112233',
        wilaya: '25 - Constantine',
        commune: 'Ziadia',
        address: 'Bvd Belouizdad',
        items: [{ variantId, qty: 1, unitPriceCentimes: 2800000n }]
      });
      orderId = order.id;

      // 1. Direct transition from NEW to SHIPPED is illegal
      await assert.rejects(
        transitionOrderStatus(tx, orderId, ORDER_STATUSES.SHIPPED),
        /Order Lifecycle Violation.*Invalid status transition/
      );

      // 2. Direct transition from NEW to DELIVERED is illegal
      await assert.rejects(
        transitionOrderStatus(tx, orderId, ORDER_STATUSES.DELIVERED),
        /Order Lifecycle Violation.*Invalid status transition/
      );
    });

    // Confirm and cancel order
    await db.withTenant({ tenantId }, async (tx) => {
      await CodConfirmationService.confirmAndReserve(tx, { orderId, locationId: warehouseLocationId });
      await CodConfirmationService.cancelAndRelease(tx, { orderId, reason: 'Out of area' });

      // 3. CANCELLED -> CONFIRMED is prohibited
      await assert.rejects(
        transitionOrderStatus(tx, orderId, ORDER_STATUSES.CONFIRMED),
        /Order Lifecycle Violation.*Invalid status transition/
      );

      // 4. CANCELLED -> SHIPPED is prohibited
      await assert.rejects(
        transitionOrderStatus(tx, orderId, ORDER_STATUSES.SHIPPED),
        /Order Lifecycle Violation.*Invalid status transition/
      );
    });
  });

  await t.test('INV-06-09 & INV-06-10: Historical OrderLine prices and delivery fee remain strictly immutable', async () => {
    let orderId = null;
    let itemId = null;

    await db.withTenant({ tenantId }, async (tx) => {
      const order = await createOnlineOrder(tx, {
        customerName: 'Fatima Zohra',
        customerPhone: '0555443322',
        wilaya: '09 - Blida',
        commune: 'Ouled Yaich',
        address: 'Cite 1024',
        deliveryFeeCentimes: 50000n,
        items: [{ variantId, qty: 1, unitPriceCentimes: 2800000n }]
      });
      orderId = order.id;
      const items = await tx.query('order_items', i => i.order_id === orderId);
      itemId = items[0].id;

      await CodConfirmationService.confirmAndReserve(tx, { orderId, locationId: warehouseLocationId });
    });

    // 1. Edit catalog variant price to 35,000 DA
    await db.withTenant({ tenantId }, async (tx) => {
      await tx.update('product_variants', variantId, {
        sale_price: 3500000n
      });
    });

    // 2. Verify order line price in database is still 28,000 DA
    await db.withTenant({ tenantId }, async (tx) => {
      const line = await tx.findById('order_items', itemId);
      assert.strictEqual(
        BigInt(line.unit_price_centimes),
        2800000n,
        'INV-06-09: Order line price permanently retains 28,000 DA snapshot'
      );

      // 3. Attempt to illegally mutate order line unit price
      await assert.rejects(
        tx.update('order_items', itemId, { unit_price_centimes: 3500000n }),
        /Order Line Immutability Violation.*cannot be altered.*INV-06-09/
      );

      // 4. Attempt to illegally mutate order delivery fee
      await assert.rejects(
        tx.update('online_orders', orderId, { delivery_fee_centimes: 90000n }),
        /Order Immutability Violation.*delivery_fee_centimes.*cannot be modified.*INV-06-10/
      );

      // 5. Attempt to delete confirmed order
      await assert.rejects(
        tx.delete('online_orders', orderId),
        /Order Immutability Violation.*cannot be deleted/
      );
    });
  });
});
