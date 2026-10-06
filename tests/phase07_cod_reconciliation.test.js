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
  DeliveryReconciliationService,
  SHIPMENT_STATUSES,
  DELIVERY_PROVIDERS,
  COURIER_COLLECTION_STATUSES,
  COURIER_SETTLEMENT_STATUSES
} = require('../src/delivery');

test('Phase 07 — COD Collection & Settlement Reconciliation Suite (INV-07-10, INV-07-18, INV-07-19, CHAOS TEST 3)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let locationId = null;
  let variantId = null;
  let orderId = null;
  let shipment = null;

  await t.test('Setup tenant, catalog, inventory, and confirmed order', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Dépôt Batna', type: 'warehouse' });
      locationId = loc.id;

      const prod = await tx.insert('products', { name: 'Djellaba Hiver' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'DJE-HIV-GRIS-L',
        size: 'L',
        color: 'Gris',
        cost_price: 450000n, // 4,500 DA
        sale_price: 740000n  // 7,400 DA
      });
      variantId = variant.id;

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: locationId,
        quantity: 10,
        movementType: 'IN',
        costPriceCentimes: 450000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      // Expected COD = 7,400 DA (740,000 centimes)
      const ord = await createOnlineOrder(tx, {
        customerName: 'Tarek Z.',
        customerPhone: '0555332211',
        wilaya: 'Batna',
        commune: 'Batna',
        address: 'Cite 1000 Logements',
        deliveryFeeCentimes: 0n, // Free shipping for clean COD match
        items: [{ variantId: variant.id, quantity: 1 }]
      });

      await CodConfirmationService.confirmAndReserve(tx, { orderId: ord.id, locationId });
      orderId = ord.id;

      shipment = await ShipmentService.createShipment(tx, {
        orderId,
        provider: DELIVERY_PROVIDERS.YALIDINE,
        customShippingFeeCentimes: 0n
      });
      assert.strictEqual(shipment.status, SHIPMENT_STATUSES.ACCEPTED);
      assert.strictEqual(shipment.cod_amount_centimes, 740000n);
    });
  });

  await t.test('CRITICAL CHAOS TEST 3 (Requirement 34): COD Expected 7400, Collected 7400, Settled 7000 -> MATCHED Collection, UNDER_SETTLED Discrepancy 400', async () => {
    // 1. Carrier delivers package and reports collected 7,400 DA
    await db.withTenant({ tenantId }, async (tx) => {
      const eventRes = await ShipmentEventProcessor.processEvent(tx, {
        provider: DELIVERY_PROVIDERS.YALIDINE,
        rawPayload: {
          status: 'livré',
          rawStatus: 'livré',
          codAmountCentimes: 740000n
        },
        externalEventId: 'evt-del-7400',
        trackingNumber: shipment.tracking_number
      });

      assert.strictEqual(eventRes.canonicalStatus, SHIPMENT_STATUSES.DELIVERED);
      assert.strictEqual(eventRes.amountMismatch, false);
    });

    // Verify Shipment is DELIVERED and CourierCollection is MATCHED
    await db.withTenant({ tenantId }, async (tx) => {
      const updatedShipment = await tx.findById('shipments', shipment.id);
      assert.strictEqual(updatedShipment.status, SHIPMENT_STATUSES.DELIVERED);

      const collections = await tx.query('courier_collections', c => c.shipment_id === shipment.id);
      assert.strictEqual(collections.length, 1);
      assert.strictEqual(collections[0].expected_centimes, 740000n);
      assert.strictEqual(collections[0].collected_centimes, 740000n);
      assert.strictEqual(collections[0].discrepancy_centimes, 0n);
      assert.strictEqual(collections[0].status, COURIER_COLLECTION_STATUSES.MATCHED);
      assert.strictEqual(collections[0].amount_mismatch, false);
    });

    // 2. Carrier sends remittance statement with short settlement: 7,000 DA instead of 7,400 DA
    let settlementResult = null;
    await db.withTenant({ tenantId }, async (tx) => {
      settlementResult = await DeliveryReconciliationService.reconcileSettlement(tx, {
        provider: DELIVERY_PROVIDERS.YALIDINE,
        settlementReference: 'YAL-REMIT-2026-001',
        remittedCentimes: 700000n, // 7,000 DA
        shipmentIds: [shipment.id]
      });
    });

    // Verify Settlement audit results (Requirement 34)
    assert.strictEqual(settlementResult.totalExpectedCod, 740000n, 'Expected COD is 7,400 DA');
    assert.strictEqual(settlementResult.remitted, 700000n, 'Remitted is 7,000 DA');
    assert.strictEqual(settlementResult.discrepancy, -40000n, 'Discrepancy is -400 DA (40,000 centimes)');
    assert.strictEqual(settlementResult.status, COURIER_SETTLEMENT_STATUSES.UNDER_SETTLED, 'Status is UNDER_SETTLED');

    // 3. Strict Boundary Invariant: ZERO silent modifications to Order, COD amount, Sales, or Inventory
    await db.withTenant({ tenantId }, async (tx) => {
      // Order total and cod amount remain 7,400 DA
      const order = await tx.findById('online_orders', orderId);
      assert.strictEqual(order.total_centimes, 740000n, 'Order total unchanged (INV-07-10)');
      assert.strictEqual(order.cod_amount_centimes, 740000n, 'Order COD amount unchanged (INV-07-10)');

      // Shipment COD amount remains 7,400 DA
      const currentShipment = await tx.findById('shipments', shipment.id);
      assert.strictEqual(currentShipment.cod_amount_centimes, 740000n, 'Shipment COD unchanged');

      // Cash register sessions are NOT mutated (INV-07-18)
      const cashTransactions = await tx.query('cash_transactions', ct => ct.tenant_id === tenantId);
      assert.strictEqual(cashTransactions.length, 0, 'No cash register transactions created (Courier != Cash Register)');

      // Inventory remains clean (10 on hand, 1 reserved or issued)
      const level = await tx.query('stock_levels', sl => sl.variant_id === variantId && sl.location_id === locationId);
      assert.strictEqual(level[0].on_hand, 10, 'Inventory on hand unchanged by courier settlement');
    });
  });

  await t.test('INV-07-10: Courier reports under-collection: Expected 7400, Reported 6900 -> Flags AMOUNT_MISMATCH', async () => {
    let order2 = null;
    let shipment2 = null;

    await db.withTenant({ tenantId }, async (tx) => {
      order2 = await createOnlineOrder(tx, {
        customerName: 'Samir L.',
        customerPhone: '0555889900',
        wilaya: 'Batna',
        commune: 'Batna',
        address: 'Centre',
        items: [{ variantId, quantity: 1 }]
      });
      await CodConfirmationService.confirmAndReserve(tx, { orderId: order2.id, locationId });

      shipment2 = await ShipmentService.createShipment(tx, {
        orderId: order2.id,
        provider: DELIVERY_PROVIDERS.YALIDINE
      });
      assert.strictEqual(shipment2.cod_amount_centimes, 740000n);
    });

    // Courier event delivers package but reports collected only 6,900 DA (690,000 centimes)
    await db.withTenant({ tenantId }, async (tx) => {
      const eventRes = await ShipmentEventProcessor.processEvent(tx, {
        provider: DELIVERY_PROVIDERS.YALIDINE,
        rawPayload: {
          status: 'livré',
          rawStatus: 'livré',
          codAmountCentimes: 690000n // Short by 500 DA
        },
        externalEventId: 'evt-del-6900',
        trackingNumber: shipment2.tracking_number
      });

      assert.strictEqual(eventRes.amountMismatch, true, 'AMOUNT_MISMATCH detected');
    });

    // Verify collection flagged and order unmodified
    await db.withTenant({ tenantId }, async (tx) => {
      const collections = await tx.query('courier_collections', c => c.shipment_id === shipment2.id);
      assert.strictEqual(collections.length, 1);
      assert.strictEqual(collections[0].amount_mismatch, true, 'Amount mismatch flag stored');
      assert.strictEqual(collections[0].expected_centimes, 740000n);
      assert.strictEqual(collections[0].collected_centimes, 690000n);
      assert.strictEqual(collections[0].discrepancy_centimes, -50000n);
      assert.strictEqual(collections[0].status, COURIER_COLLECTION_STATUSES.UNDER_COLLECTION);

      // Order total remains strictly 7,400 DA
      const order = await tx.findById('online_orders', order2.id);
      assert.strictEqual(order.total_centimes, 740000n);
      assert.strictEqual(order.cod_amount_centimes, 740000n);
    });
  });
});
