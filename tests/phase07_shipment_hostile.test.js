const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { createOnlineOrder } = require('../src/orders/orders');
const { CodConfirmationService } = require('../src/orders/confirmation_service');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const {
  ShipmentService,
  SHIPMENT_STATUSES,
  DELIVERY_PROVIDERS,
  DELIVERY_TYPES
} = require('../src/delivery');

test('Phase 07 — Shipment Hostile & Boundary Attack Suite', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let locationA = null;
  let variantA = null;
  let confirmedOrderA = null;
  let newOrderA = null;

  await t.test('Setup isolated tenant environments, catalog, and inventory', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Dépôt Alger', type: 'warehouse' });
      locationA = loc.id;

      const prod = await tx.insert('products', { name: 'Robe Kabyle Traditionnelle' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'ROB-KAB-JAUNE-M',
        size: 'M',
        color: 'Jaune',
        cost_price: 400000n, // 4,000 DA
        sale_price: 750000n  // 7,500 DA
      });
      variantA = variant.id;

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: locationA,
        quantity: 25,
        movementType: 'IN',
        costPriceCentimes: 400000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      // 1. Confirmed Order
      const ord1 = await createOnlineOrder(tx, {
        customerName: 'Fatima Zohra',
        customerPhone: '0555123456',
        wilaya: 'Oran',
        commune: 'Bir El Djir',
        address: 'Rue de la Paix',
        items: [{ variantId: variant.id, quantity: 2 }]
      });
      await CodConfirmationService.confirmAndReserve(tx, { orderId: ord1.id, locationId: locationA });
      confirmedOrderA = ord1.id;

      // 2. New Order (Unconfirmed)
      const ord2 = await createOnlineOrder(tx, {
        customerName: 'Kamel B.',
        customerPhone: '0661223344',
        wilaya: 'Blida',
        commune: 'Boufarik',
        address: 'Centre ville',
        items: [{ variantId: variant.id, quantity: 1 }]
      });
      newOrderA = ord2.id;
    });
  });

  await t.test('Hostile: Shipping an unconfirmed order in NEW status is strictly blocked', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => {
          await ShipmentService.createShipment(tx, {
            orderId: newOrderA,
            provider: DELIVERY_PROVIDERS.YALIDINE
          });
        },
        /cannot be shipped from status 'NEW'/
      );
    });
  });

  await t.test('INV-07-14: IDOR Attack: Tenant B cannot create shipment for Tenant A order', async () => {
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      await assert.rejects(
        async () => {
          await ShipmentService.createShipment(tx, {
            orderId: confirmedOrderA,
            provider: DELIVERY_PROVIDERS.YALIDINE
          });
        },
        /Order not found/
      );
    });
  });

  await t.test('Hostile: Shipping order with invalid Algerian wilaya is rejected', async () => {
    let badOrder = null;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      badOrder = await tx.insert('online_orders', {
        order_number: 'BF-INVALID-W',
        customer_name: 'Test Hack',
        customer_phone: '0555000000',
        wilaya: 'InvalidWilayaName99',
        commune: 'FakeTown',
        address: 'Nowhere',
        status: 'CONFIRMED',
        total_centimes: 500000n,
        cod_amount_centimes: 500000n
      });

      await assert.rejects(
        async () => {
          await ShipmentService.createShipment(tx, {
            orderId: badOrder.id,
            provider: DELIVERY_PROVIDERS.YALIDINE
          });
        },
        /Invalid Algerian wilaya/
      );
    });
  });

  await t.test('Happy Path: Create valid shipment with Yalidine adapter', async () => {
    let shipment = null;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      shipment = await ShipmentService.createShipment(tx, {
        orderId: confirmedOrderA,
        provider: DELIVERY_PROVIDERS.YALIDINE,
        isStopdesk: true,
        customShippingFeeCentimes: 45000n
      });

      assert.ok(shipment.id, 'Shipment ID generated');
      assert.strictEqual(shipment.tenant_id, tenantA);
      assert.strictEqual(shipment.order_id, confirmedOrderA);
      assert.strictEqual(shipment.status, SHIPMENT_STATUSES.ACCEPTED);
      assert.strictEqual(shipment.delivery_type, DELIVERY_TYPES.STOP_DESK);
      assert.strictEqual(shipment.shipping_fee_at_creation_centimes, 45000n);
      assert.strictEqual(shipment.cod_amount_centimes, 1500000n); // 2 x 7500 DA = 15,000 DA
      assert.ok(shipment.tracking_number.startsWith('yal-'), 'Tracking code prefixed correctly');
      assert.ok(shipment.recipient_snapshot.pickupLocation, 'Stopdesk location snapshotted');

      // Verify commercial order was marked READY_TO_SHIP
      const order = await tx.findById('online_orders', confirmedOrderA);
      assert.strictEqual(order.status, 'READY_TO_SHIP');
      assert.strictEqual(order.tracking_code, shipment.tracking_number);
    });
  });

  await t.test('INV-07-06: Direct deletion of shipment is strictly prohibited', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const shipments = await tx.query('shipments', s => s.order_id === confirmedOrderA);
      assert.strictEqual(shipments.length, 1);
      const sId = shipments[0].id;

      await assert.rejects(
        async () => {
          await tx.delete('shipments', sId);
        },
        /Shipment Immutability Violation: Shipments cannot be deleted/
      );
    });
  });

  await t.test('INV-07-11: Modifying historical shipping_fee_at_creation_centimes is blocked', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const shipments = await tx.query('shipments', s => s.order_id === confirmedOrderA);
      const sId = shipments[0].id;

      await assert.rejects(
        async () => {
          await tx.update('shipments', sId, {
            shipping_fee_at_creation_centimes: 999999n
          });
        },
        /Shipment Immutability Violation: Historical shipping fee snapshot cannot be modified/
      );
    });
  });

  await t.test('INV-07-01: Modifying shipment order_id is strictly blocked', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const shipments = await tx.query('shipments', s => s.order_id === confirmedOrderA);
      const sId = shipments[0].id;

      await assert.rejects(
        async () => {
          await tx.update('shipments', sId, {
            order_id: generateUUIDv7()
          });
        },
        /Shipment Immutability Violation: Shipment order_id cannot be modified/
      );
    });
  });
});
