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
  ShipmentReturnService,
  SHIPMENT_STATUSES,
  SHIPMENT_RETURN_STATUSES,
  DELIVERY_PROVIDERS
} = require('../src/delivery');

test('Phase 07 — Inventory Decoupling & Returns Restock Boundary Suite (INV-07-02, INV-07-12, INV-07-13)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let locationId = null;
  let variantId = null;
  let orderId = null;
  let shipment = null;

  await t.test('Setup tenant, inventory (10 units), and confirmed order with 2 units shipped', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Dépôt Annaba', type: 'warehouse' });
      locationId = loc.id;

      const prod = await tx.insert('products', { name: 'Seroual Loubia' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'SER-LOU-NOIR-M',
        size: 'M',
        color: 'Noir',
        cost_price: 180000n, // 1,800 DA
        sale_price: 320000n  // 3,200 DA
      });
      variantId = variant.id;

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: locationId,
        quantity: 10,
        movementType: 'IN',
        costPriceCentimes: 180000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      const ord = await createOnlineOrder(tx, {
        customerName: 'Anis K.',
        customerPhone: '0555667788',
        wilaya: 'Annaba',
        commune: 'Annaba',
        address: 'Cours de la Révolution',
        items: [{ variantId: variant.id, quantity: 2 }]
      });

      await CodConfirmationService.confirmAndReserve(tx, { orderId: ord.id, locationId });
      orderId = ord.id;

      shipment = await ShipmentService.createShipment(tx, {
        orderId,
        provider: DELIVERY_PROVIDERS.YALIDINE
      });
      assert.strictEqual(shipment.status, SHIPMENT_STATUSES.ACCEPTED);

      // Verify on-hand stock is 10, reserved is 2
      const level = await tx.query('stock_levels', sl => sl.variant_id === variantId && sl.location_id === locationId);
      assert.strictEqual(level[0].on_hand, 10);
      assert.strictEqual(level[0].reserved, 2);
    });
  });

  await t.test('INV-07-12: Carrier notifies RETURNED -> Zero automatic stock restock occurs', async () => {
    // Carrier notifies package is RETURNED
    await db.withTenant({ tenantId }, async (tx) => {
      const eventRes = await ShipmentEventProcessor.processEvent(tx, {
        provider: DELIVERY_PROVIDERS.YALIDINE,
        rawPayload: { status: 'retourné au vendeur', rawStatus: 'retourné au vendeur' },
        externalEventId: 'evt-ret-001',
        trackingNumber: shipment.tracking_number
      });

      assert.strictEqual(eventRes.canonicalStatus, SHIPMENT_STATUSES.RETURNED);
    });

    // Verify shipment and order are marked RETURNED, but inventory has ZERO mutation
    await db.withTenant({ tenantId }, async (tx) => {
      const updatedShipment = await tx.findById('shipments', shipment.id);
      assert.strictEqual(updatedShipment.status, SHIPMENT_STATUSES.RETURNED);

      const updatedOrder = await tx.findById('online_orders', orderId);
      assert.strictEqual(updatedOrder.status, 'RETURNED');

      // ShipmentReturn record exists in RECEIVED status
      const returns = await tx.query('shipment_returns', r => r.shipment_id === shipment.id);
      assert.strictEqual(returns.length, 1);
      assert.strictEqual(returns[0].status, SHIPMENT_RETURN_STATUSES.RECEIVED);
      assert.strictEqual(returns[0].is_restocked, false);

      // CRITICAL CHECK: On-hand stock is still 10, no automatic increase!
      const level = await tx.query('stock_levels', sl => sl.variant_id === variantId && sl.location_id === locationId);
      assert.strictEqual(level[0].on_hand, 10, 'On-hand stock strictly NOT mutated by carrier return (INV-07-12)');
    });
  });

  await t.test('INV-07-13: Restocking damaged goods is rejected; Inspection must approve restock', async () => {
    let returnRecord = null;
    await db.withTenant({ tenantId }, async (tx) => {
      const returns = await tx.query('shipment_returns', r => r.shipment_id === shipment.id);
      returnRecord = returns[0];

      // Attempting to restock before inspection throws error
      await assert.rejects(
        async () => {
          await ShipmentReturnService.restockReturn(tx, {
            returnId: returnRecord.id,
            locationId
          });
        },
        /has not passed inspection/
      );

      // Perform inspection: Mark as DAMAGED
      await ShipmentReturnService.inspectReturn(tx, {
        returnId: returnRecord.id,
        isRestockable: false,
        condition: 'DAMAGED',
        notes: 'Emballage déchiré, tâche sur le tissu'
      });

      // Attempting to restock damaged return throws error
      await assert.rejects(
        async () => {
          await ShipmentReturnService.restockReturn(tx, {
            returnId: returnRecord.id,
            locationId
          });
        },
        /has not passed inspection or is damaged/
      );
    });
  });

  await t.test('INV-07-13: Authoritative restock of approved return invokes InventoryService and increments on-hand stock', async () => {
    let restockableReturn = null;
    await db.withTenant({ tenantId }, async (tx) => {
      // Create a clean restockable return
      restockableReturn = await ShipmentReturnService.createReturn(tx, {
        shipmentId: shipment.id,
        reason: 'SIZE_EXCHANGE'
      });

      await ShipmentReturnService.receiveReturn(tx, {
        returnId: restockableReturn.id,
        receivedLocationId: locationId
      });

      // Inspection passes
      await ShipmentReturnService.inspectReturn(tx, {
        returnId: restockableReturn.id,
        isRestockable: true,
        condition: 'PERFECT',
        notes: 'Article neuf avec étiquette'
      });

      // Execute authoritative restock
      const restockRes = await ShipmentReturnService.restockReturn(tx, {
        returnId: restockableReturn.id,
        locationId
      });

      assert.strictEqual(restockRes.status, SHIPMENT_RETURN_STATUSES.RESTOCKED);
      assert.strictEqual(restockRes.restockedCount, 1);

      // Verify on-hand stock increased by 2 (from 10 to 12)
      const level = await tx.query('stock_levels', sl => sl.variant_id === variantId && sl.location_id === locationId);
      assert.strictEqual(level[0].on_hand, 12, 'On hand stock incremented by authoritative restock');

      // Verify stock movement ledger entry was created
      const movements = await tx.query('stock_movements', sm =>
        sm.variant_id === variantId &&
        sm.reference_type === 'RETURN_RESTOCK' &&
        sm.reference_id === restockableReturn.id
      );
      assert.strictEqual(movements.length, 1, 'Stock movement ledger record created');
      assert.strictEqual(movements[0].qty, 2);

      // Verify double restock is blocked
      await assert.rejects(
        async () => {
          await ShipmentReturnService.restockReturn(tx, {
            returnId: restockableReturn.id,
            locationId
          });
        },
        /already been restocked/
      );
    });
  });
});
