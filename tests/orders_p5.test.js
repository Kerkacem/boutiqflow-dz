const test = require('node:test');
const assert = require('node:assert');
const {
  ORDER_STATUSES,
  createOnlineOrder,
  confirmOrder,
  shipOrder,
  deliverOrder,
  receiveReturnedOrder,
  generateWhatsAppLink,
  logCallAttempt
} = require('../src/orders/orders');
const { reconcileCourierRemittance, computeDeliveryMetrics } = require('../src/orders/remittance');
const { YalidineAdapter } = require('../src/couriers/yalidine');
const { EcotrackAdapter, ZrExpressAdapter } = require('../src/couriers/ecotrack');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase P5 — Online Orders, COD Logistics, Couriers & Scenarios', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let shopLocationId = null;
  let warehouseLocationId = null;
  let variantId = null;
  let yalidineAdapter = null;
  let courierAccountId = null;

  await t.test('Setup tenant, locations, product variant, and courier account', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const shop = await tx.insert('inventory_locations', { name: 'Boutique Principale', type: 'shop' });
      const wh = await tx.insert('inventory_locations', { name: 'Dépôt Expédition', type: 'warehouse' });
      shopLocationId = shop.id;
      warehouseLocationId = wh.id;

      const prod = await tx.insert('products', { name: 'Abaya Moderne' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'ABY-MOD-NOIR-L',
        size: 'L',
        color: 'Noir',
        cost_price: 350000n, // 3,500 DA
        sale_price: 680000n  // 6,800 DA
      });
      variantId = variant.id;

      // Seed 20 units in warehouse
      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: warehouseLocationId,
        qty: 20,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      // Register Yalidine courier account
      const courierAccount = await tx.insert('courier_accounts', {
        provider: 'YALIDINE',
        account_name: 'Compte Yalidine Alger',
        api_key_encrypted: 'enc_api_key_123',
        api_token_encrypted: 'enc_token_456'
      });
      courierAccountId = courierAccount.id;

      yalidineAdapter = new YalidineAdapter({
        id: courierAccountId,
        apiKey: 'api_key_123',
        apiToken: 'token_456'
      });
    });
  });

  await t.test('Courier Adapter Contract Verification: Yalidine, Ecotrack, ZR Express', async () => {
    const adapters = [
      yalidineAdapter,
      new EcotrackAdapter({ id: generateUUIDv7(), apiKey: 'eco_key' }),
      new ZrExpressAdapter({ id: generateUUIDv7(), apiKey: 'zr_key' })
    ];

    for (const adapter of adapters) {
      // 1. listTerritories()
      const territories = await adapter.listTerritories();
      assert.ok(Array.isArray(territories), `${adapter.provider} territories must be array`);
      assert.ok(territories.length > 0);

      // 2. quote()
      const quote = await adapter.quote({ wilaya: 'Alger', commune: 'Hydra', isStopdesk: false });
      assert.ok(quote.shippingCostCentimes > 0n);

      // 3. createShipment()
      const shipment = await adapter.createShipment({
        orderNumber: 'TEST-001',
        customerName: 'Karim Client',
        customerPhone: '+213550123456',
        address: '12 Rue Larbi Ben Mhidi',
        wilaya: 'Alger',
        commune: 'Alger Centre',
        codAmountCentimes: 680000n
      });

      assert.ok(shipment.trackingCode.startsWith(adapter.provider === 'YALIDINE' ? 'yal-' : adapter.provider === 'ECOTRACK' ? 'eco-' : 'zr-'));
      assert.ok(shipment.labelUrl.includes(shipment.trackingCode));

      // 4. track() & cancel()
      const tracking = await adapter.track(shipment.trackingCode);
      assert.strictEqual(tracking.status, 'IN_TRANSIT');

      const cancelled = await adapter.cancel(shipment.trackingCode);
      assert.strictEqual(cancelled.status, 'CANCELLED');
    }
  });

  await t.test('UAT-6: Online Order Lifecycle & COD Remittance Reconciliation', async () => {
    let order = null;

    // 1. Order Creation (Status: NEW)
    await db.withTenant({ tenantId }, async (tx) => {
      order = await createOnlineOrder(tx, {
        source: 'MANUAL',
        customerName: 'Fatima Zohra',
        customerPhone: '0555987654',
        wilaya: 'Oran',
        commune: 'Bir El Djir',
        address: 'Cité 500 Logements',
        items: [{ variantId, qty: 2, unitPriceCentimes: 680000n }], // 2 units @ 6,800 DA = 13,600 DA
        shippingFeeCentimes: 70000n // 700 DA shipping
      });

      assert.strictEqual(order.status, ORDER_STATUSES.NEW);
      assert.strictEqual(order.customer_phone, '+213555987654'); // Phone normalized
      assert.strictEqual(order.total_centimes, 1430000n); // 13,600 + 700 = 14,300 DA
    });

    // 2. Order Confirmation: Reserves stock in warehouse (INV-2)
    await db.withTenant({ tenantId }, async (tx) => {
      await confirmOrder(tx, order.id, warehouseLocationId);

      const level = (await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === warehouseLocationId))[0];
      assert.strictEqual(level.on_hand, 20, 'on_hand unchanged on confirm');
      assert.strictEqual(level.reserved, 2, '2 units reserved');
      assert.strictEqual(level.available, 18, 'Available is 20 - 2 = 18');
    });

    // 3. Order Shipment: Deducts stock, creates courier shipment
    let shippedOrder = null;
    await db.withTenant({ tenantId }, async (tx) => {
      shippedOrder = await shipOrder(tx, {
        orderId: order.id,
        courierAdapter: yalidineAdapter,
        isStopdesk: false
      });

      assert.strictEqual(shippedOrder.status, ORDER_STATUSES.SHIPPED);
      assert.ok(shippedOrder.tracking_code.startsWith('yal-'));
      assert.ok(shippedOrder.label_url.includes(shippedOrder.tracking_code));

      // Stock level check: on_hand decremented by 2, reserved released to 0
      const level = (await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === warehouseLocationId))[0];
      assert.strictEqual(level.on_hand, 18, 'on_hand decremented to 18');
      assert.strictEqual(level.reserved, 0, 'Reservation released');
      assert.strictEqual(level.available, 18);
    });

    // 4. Order Delivery
    await db.withTenant({ tenantId }, async (tx) => {
      await deliverOrder(tx, order.id);
      const delivered = await tx.findById('online_orders', order.id);
      assert.strictEqual(delivered.status, ORDER_STATUSES.DELIVERED);

      // Update shipment status to DELIVERED
      const shipments = await tx.query('shipments', s => s.order_id === order.id);
      assert.strictEqual(shipments.length, 1);
      await tx.update('shipments', shipments[0].id, { status: 'DELIVERED' });

      // 5. COD Remittance Reconciliation
      // Expected COD: 14,300 DA (1,430,000 centimes)
      // Yalidine Shipping Fee: 700 DA (70,000 centimes)
      // Net Expected Remittance: 14,300 - 700 = 13,600 DA (1,360,000 centimes)
      // Courier remits exact 13,600 DA
      const remittance = await reconcileCourierRemittance(tx, {
        courierAccountId,
        reference: 'REMIT-YAL-2026-10',
        receivedCentimes: 1360000n,
        shipmentIds: [shipments[0].id]
      });

      assert.strictEqual(remittance.netExpected, 1360000n);
      assert.strictEqual(remittance.difference, 0n, 'Clean reconciliation with 0 DA discrepancy');
    });
  });

  await t.test('UAT-7: Customer Return & Restocking into Shop Location', async () => {
    let returnOrder = null;

    await db.withTenant({ tenantId }, async (tx) => {
      returnOrder = await createOnlineOrder(tx, {
        customerName: 'Samir Brahimi',
        customerPhone: '0661123456',
        wilaya: 'Constantine',
        commune: 'El Khroub',
        address: 'Rue 1er Novembre',
        items: [{ variantId, qty: 1, unitPriceCentimes: 680000n }],
        shippingFeeCentimes: 70000n
      });

      await confirmOrder(tx, returnOrder.id, warehouseLocationId);
      await shipOrder(tx, { orderId: returnOrder.id, courierAdapter: yalidineAdapter });

      const stockBeforeReturn = (await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === shopLocationId))[0]?.on_hand || 0;

      // Customer refuses parcel upon delivery -> Parcel returns to shop location
      await receiveReturnedOrder(tx, {
        orderId: returnOrder.id,
        restockLocationId: shopLocationId
      });

      const updatedOrder = await tx.findById('online_orders', returnOrder.id);
      assert.strictEqual(updatedOrder.status, ORDER_STATUSES.RETURN_RECEIVED);

      // Verify stock in shop location incremented by 1
      const stockAfterReturn = (await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === shopLocationId))[0].on_hand;
      assert.strictEqual(stockAfterReturn, stockBeforeReturn + 1, 'Shop inventory must increment by returned quantity');
    });
  });

  await t.test('UAT-18: Duplicate Order & Risky Customer Detection', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const phone = '0770123987';

      // Order 1
      const order1 = await createOnlineOrder(tx, {
        customerName: 'Walid Risky',
        customerPhone: phone,
        wilaya: 'Alger',
        commune: 'Hydra',
        address: 'Villa 14',
        items: [{ variantId, qty: 1, unitPriceCentimes: 680000n }]
      });
      assert.strictEqual(order1.is_duplicate, false);

      // Order 2 with identical phone placed immediately -> flagged as duplicate
      const order2 = await createOnlineOrder(tx, {
        customerName: 'Walid Risky Duplicate',
        customerPhone: phone,
        wilaya: 'Alger',
        commune: 'Hydra',
        address: 'Villa 14',
        items: [{ variantId, qty: 1, unitPriceCentimes: 680000n }]
      });
      assert.strictEqual(order2.is_duplicate, true, 'Second order within 24h must be flagged duplicate');

      // Simulate customer having 2 historical refused/cancelled orders
      await tx.update('online_orders', order1.id, { status: ORDER_STATUSES.RETURN_RECEIVED });
      await tx.update('online_orders', order2.id, { status: ORDER_STATUSES.CANCELLED });

      // Order 3 by same customer -> flagged as risky
      const order3 = await createOnlineOrder(tx, {
        customerName: 'Walid Risky 3',
        customerPhone: phone,
        wilaya: 'Alger',
        commune: 'Hydra',
        address: 'Villa 14',
        items: [{ variantId, qty: 1, unitPriceCentimes: 680000n }]
      });

      assert.strictEqual(order3.is_risky, true, 'Customer with 2+ returned/cancelled orders must be flagged risky');
      assert.ok(order3.risk_reason.includes('previously returned/cancelled'));
    });
  });

  await t.test('WhatsApp Link Generator & Call Attempts Log', async () => {
    const link = generateWhatsAppLink('+213550112233', 'مرحباً، تم تأكيد طلبيتك رقم CMD-00123');
    assert.strictEqual(link.startsWith('https://wa.me/213550112233'), true);
    assert.ok(link.includes(encodeURIComponent('CMD-00123')));

    await db.withTenant({ tenantId }, async (tx) => {
      const orders = await tx.query('online_orders');
      const testOrder = orders[0];

      const call = await logCallAttempt(tx, {
        orderId: testOrder.id,
        callerId: generateUUIDv7(),
        outcome: 'NO_ANSWER',
        notes: 'Sonnerie occupée, rappel prévu à 14h'
      });

      assert.ok(call.id);
      assert.strictEqual(call.outcome, 'NO_ANSWER');
    });
  });
});
