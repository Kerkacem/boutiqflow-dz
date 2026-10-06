const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { createOnlineOrder } = require('../src/orders/orders');
const { CodConfirmationService } = require('../src/orders/confirmation_service');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const {
  ShipmentService,
  ShipmentEventProcessor,
  SHIPMENT_STATUSES,
  DELIVERY_PROVIDERS
} = require('../src/delivery');

test('Phase 07 — Status Regression & Out-of-Order Webhook Suite (INV-07-09, CHAOS TEST 2)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let orderId = null;
  let shipment = null;

  await t.test('Setup tenant order and dispatch shipment', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Dépôt Constantine', type: 'shop' });
      const prod = await tx.insert('products', { name: 'Karakou Algérois' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'KAR-ALG-VEL-S',
        size: 'S',
        color: 'Bleu Nuit',
        cost_price: 1500000n, // 15,000 DA
        sale_price: 2800000n  // 28,000 DA
      });

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: loc.id,
        quantity: 5,
        movementType: 'IN',
        costPriceCentimes: 1500000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      const ord = await createOnlineOrder(tx, {
        customerName: 'Samia Hadj',
        customerPhone: '0555443322',
        wilaya: 'Alger',
        commune: 'Hydra',
        address: 'Boulevard des Martyrs',
        items: [{ variantId: variant.id, quantity: 1 }]
      });
      await CodConfirmationService.confirmAndReserve(tx, { orderId: ord.id, locationId: loc.id });
      orderId = ord.id;

      shipment = await ShipmentService.createShipment(tx, {
        orderId,
        provider: DELIVERY_PROVIDERS.YALIDINE,
        isStopdesk: false
      });
      assert.strictEqual(shipment.status, SHIPMENT_STATUSES.ACCEPTED);
    });
  });

  await t.test('CRITICAL CHAOS TEST 2 (Requirement 33): Out-of-Order Events sequence prevents status regression', async () => {
    // Sequence: PICKED_UP -> DELIVERED -> DELIVERED -> IN_TRANSIT (old) -> DELIVERED
    const events = [
      { id: 'evt-01', status: 'ramassé', rawStatus: 'ramassé', expectedCanonical: SHIPMENT_STATUSES.PICKED_UP },
      { id: 'evt-02', status: 'livré', rawStatus: 'livré', expectedCanonical: SHIPMENT_STATUSES.DELIVERED },
      { id: 'evt-03', status: 'livré', rawStatus: 'livré', expectedCanonical: SHIPMENT_STATUSES.DELIVERED },
      { id: 'evt-04', status: 'en transit', rawStatus: 'en transit', expectedCanonical: SHIPMENT_STATUSES.IN_TRANSIT, isOlder: true },
      { id: 'evt-05', status: 'livré', rawStatus: 'livré', expectedCanonical: SHIPMENT_STATUSES.DELIVERED }
    ];

    for (const evt of events) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await ShipmentEventProcessor.processEvent(tx, {
          provider: DELIVERY_PROVIDERS.YALIDINE,
          rawPayload: { status: evt.status, rawStatus: evt.rawStatus },
          externalEventId: evt.id,
          trackingNumber: shipment.tracking_number
        });

        assert.ok(res.success, `Event ${evt.id} processed`);
        if (evt.isOlder) {
          // Out of order event was detected and prevented from regressing shipment status
          assert.strictEqual(res.isRegressed, true, 'Event detected as status regression attempt');
          assert.strictEqual(res.shipmentStatus, SHIPMENT_STATUSES.DELIVERED, 'Shipment status protected from regression');
        }
      });
    }

    // Verify final state
    await db.withTenant({ tenantId }, async (tx) => {
      const finalShipment = await tx.findById('shipments', shipment.id);
      assert.strictEqual(finalShipment.status, SHIPMENT_STATUSES.DELIVERED, 'Final status strictly remains DELIVERED (INV-07-09)');

      // Verify all 5 raw events are recorded in append-only provider_events ledger
      const recordedEvents = await tx.query('provider_events', e => e.shipment_id === shipment.id);
      assert.strictEqual(recordedEvents.length, 5, 'All 5 raw provider events recorded in ledger');

      // Verify commercial order is DELIVERED
      const order = await tx.findById('online_orders', orderId);
      assert.strictEqual(order.status, 'DELIVERED');
    });
  });

  await t.test('INV-07-03: Prohibited state transitions: Cancelled shipment cannot be revived by out-of-order webhook', async () => {
    let cancelledShipment = null;

    await db.withTenant({ tenantId }, async (tx) => {
      const loc = (await tx.query('inventory_locations', l => l.tenant_id === tenantId))[0];
      const variant = (await tx.query('product_variants', v => v.tenant_id === tenantId))[0];

      const ord = await createOnlineOrder(tx, {
        customerName: 'Nabil K.',
        customerPhone: '0661009988',
        wilaya: 'Blida',
        commune: 'Blida',
        address: 'Place Bab Dzair',
        items: [{ variantId: variant.id, quantity: 1 }]
      });
      await CodConfirmationService.confirmAndReserve(tx, { orderId: ord.id, locationId: loc.id });

      cancelledShipment = await ShipmentService.createShipment(tx, {
        orderId: ord.id,
        provider: DELIVERY_PROVIDERS.YALIDINE
      });

      // Cancel shipment
      await ShipmentService.cancelShipment(tx, { shipmentId: cancelledShipment.id, reason: 'Customer changed mind' });
      const current = await tx.findById('shipments', cancelledShipment.id);
      assert.strictEqual(current.status, SHIPMENT_STATUSES.CANCELLED);

      // Delayed webhook arrives claiming package is IN_TRANSIT
      const res = await ShipmentEventProcessor.processEvent(tx, {
        provider: DELIVERY_PROVIDERS.YALIDINE,
        rawPayload: { status: 'en transit', rawStatus: 'en transit' },
        externalEventId: 'evt-delayed-after-cancel',
        trackingNumber: cancelledShipment.tracking_number
      });

      assert.strictEqual(res.shipmentStatus, SHIPMENT_STATUSES.CANCELLED, 'Cancelled shipment status is preserved');

      // Verify DB status remains CANCELLED
      const rechecked = await tx.findById('shipments', cancelledShipment.id);
      assert.strictEqual(rechecked.status, SHIPMENT_STATUSES.CANCELLED);
    });
  });
});
