const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { createOnlineOrder } = require('../src/orders/orders');
const { CodConfirmationService, CONFIRMATION_STATUSES, CONFIRMATION_CHANNELS } = require('../src/orders/confirmation_service');
const { applyStockMovement, getOrCreateStockLevel } = require('../src/inventory/ledger');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase 6 — COD Confirmation Domain & Authoritative Stock Reservation', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const agentId = generateUUIDv7();
  let locationId;
  let variantId;

  await t.test('Setup tenant, store location, and test variant stock', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Magasin Alger', is_store: true });
      locationId = loc.id;

      const prod = await tx.insert('products', { name: 'Veste Cuir DZ', category: 'Vestes' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'VST-CUIR-BLK-XL',
        barcode: '2000000000055',
        color: 'Noir',
        size: 'XL',
        cost_price_centimes: 600000n, // 6,000 DA
        selling_price_centimes: 1200000n // 12,000 DA
      });
      variantId = variant.id;

      // Initial Stock: 5 units on hand
      await applyStockMovement(tx, {
        variantId,
        locationId,
        qty: 5,
        costPriceCentimes: 600000n,
        reason: 'RECEIVING'
      });

      const level = await getOrCreateStockLevel(tx, variantId, locationId);
      assert.strictEqual(level.on_hand, 5);
      assert.strictEqual(level.reserved, 0);
      assert.strictEqual(level.available, 5);
    });
  });

  await t.test('New Inbound Order does NOT reserve stock prematurely', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const order = await createOnlineOrder(tx, {
        customerName: 'Yassine Mebarki',
        customerPhone: '0550112233',
        wilaya: '31 - Oran',
        commune: 'Es Senia',
        address: 'Cite Universitaire',
        source: 'FACEBOOK',
        shippingFeeCentimes: 70000n,
        items: [{ variantId, qty: 1, unitPriceCentimes: 1200000n }]
      });

      // Stock remains Available: 5, Reserved: 0 (No premature reservation)
      const level = await getOrCreateStockLevel(tx, variantId, locationId);
      assert.strictEqual(level.available, 5);
      assert.strictEqual(level.reserved, 0);
      assert.strictEqual(order.status, 'NEW');
    });
  });

  await t.test('Call Attempt State Machine: UNREACHABLE schedules retry', async () => {
    let orderId;
    await db.withTenant({ tenantId }, async (tx) => {
      const order = await createOnlineOrder(tx, {
        customerName: 'Kamel Taleb',
        customerPhone: '0661223344',
        wilaya: '16 - Alger',
        commune: 'Bab El Oued',
        address: 'Rue Colonel Lotfi',
        source: 'INSTAGRAM',
        items: [{ variantId, qty: 1, unitPriceCentimes: 1200000n }]
      });
      orderId = order.id;

      // Attempt 1: No Answer -> Status becomes UNREACHABLE
      const attempt1 = await CodConfirmationService.logCallAttempt(tx, {
        orderId,
        agentId,
        channel: CONFIRMATION_CHANNELS.PHONE_CALL,
        outcome: 'NO_ANSWER',
        nextAttemptAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
        notes: 'Sonnerie sans reponse'
      });

      assert.strictEqual(attempt1.attempt_number, 1);
      const updatedOrder = await tx.findById('online_orders', orderId);
      assert.strictEqual(updatedOrder.confirmation_status, CONFIRMATION_STATUSES.UNREACHABLE);
      assert.strictEqual(updatedOrder.call_attempts_count, 1);
    });
  });

  await t.test('Confirmation Domain: CONFIRMED triggers atomic inventory reservation (INV-2)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const order = await createOnlineOrder(tx, {
        customerName: 'Samir Bouzid',
        customerPhone: '0770334455',
        wilaya: '25 - Constantine',
        commune: 'El Khroub',
        address: 'Zone Industrielle',
        source: 'SHOPIFY',
        items: [{ variantId, qty: 2, unitPriceCentimes: 1200000n }]
      });

      // Confirm and reserve 2 units
      const confirmRes = await CodConfirmationService.confirmAndReserve(tx, {
        orderId: order.id,
        locationId,
        agentId,
        notes: 'Client confirme - livraison apres 16h'
      });

      assert.strictEqual(confirmRes.status, 'CONFIRMED');
      assert.strictEqual(confirmRes.reservationsCount, 1);

      // Verify Inventory Ledger Invariant (OnHand = 5, Reserved = 2, Available = 3)
      const level = await getOrCreateStockLevel(tx, variantId, locationId);
      assert.strictEqual(level.on_hand, 5);
      assert.strictEqual(level.reserved, 2);
      assert.strictEqual(level.available, 3);
    });
  });

  await t.test('Cancellation Domain: Releases reservation cleanly back to available stock (INV-8)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const order = await createOnlineOrder(tx, {
        customerName: 'Nabil Larbi',
        customerPhone: '0560445566',
        wilaya: '09 - Blida',
        commune: 'Blida',
        address: 'Place 1er Mai',
        source: 'MANUAL',
        items: [{ variantId, qty: 1, unitPriceCentimes: 1200000n }]
      });

      await CodConfirmationService.confirmAndReserve(tx, { orderId: order.id, locationId, agentId });
      let level = await getOrCreateStockLevel(tx, variantId, locationId);
      assert.strictEqual(level.reserved, 3); // Previous 2 + 1 = 3

      // Customer calls back to cancel
      await CodConfirmationService.cancelAndRelease(tx, { orderId: order.id, reason: 'Customer changed mind' });

      level = await getOrCreateStockLevel(tx, variantId, locationId);
      assert.strictEqual(level.on_hand, 5);
      assert.strictEqual(level.reserved, 2); // Released 1 unit back
      assert.strictEqual(level.available, 3);
    });
  });
});
