const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { createOnlineOrder } = require('../src/orders/orders');
const { CodConfirmationService } = require('../src/orders/confirmation_service');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const {
  ShipmentService,
  FakeDeliveryProvider,
  SHIPMENT_STATUSES,
  DELIVERY_PROVIDERS
} = require('../src/delivery');

test('Phase 07 — Timeout Recovery, Bounded Retry & Idempotency Suite (INV-07-04, INV-07-08, CHAOS TEST 1)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let locationId = null;
  let variantId = null;
  let orderId = null;
  let sandboxAdapter = null;

  await t.test('Setup tenant, catalog, inventory, and confirmed order with active reservation', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Dépôt Oran', type: 'warehouse' });
      locationId = loc.id;

      const prod = await tx.insert('products', { name: 'Caftan Moderne' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'CAF-MOD-ROSE-M',
        size: 'M',
        color: 'Rose',
        cost_price: 500000n, // 5,000 DA
        sale_price: 900000n  // 9,000 DA
      });
      variantId = variant.id;

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: locationId,
        quantity: 10,
        movementType: 'IN',
        costPriceCentimes: 500000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      const ord = await createOnlineOrder(tx, {
        customerName: 'Meriem B.',
        customerPhone: '0555778899',
        wilaya: 'Oran',
        commune: 'Maraval',
        address: 'Rue 12, Lot 4',
        items: [{ variantId: variant.id, quantity: 2 }]
      });

      await CodConfirmationService.confirmAndReserve(tx, { orderId: ord.id, locationId });
      orderId = ord.id;

      // Verify stock: 10 on hand, 2 reserved, 8 available
      const level = await tx.query('stock_levels', sl => sl.variant_id === variantId && sl.location_id === locationId);
      assert.strictEqual(level[0].on_hand, 10);
      assert.strictEqual(level[0].reserved, 2);
    });

    sandboxAdapter = new FakeDeliveryProvider({ id: 'acc-sbx-chaos' });
  });

  await t.test('CRITICAL CHAOS TEST 1 (Requirement 32): Timeout after remote creation + 10 Retries yields 1 shipment, 1 parcel, 0 duplicates', async () => {
    const operationId = `op-ship-timeout-${generateUUIDv7()}`;

    // Simulate Network Timeout: Carrier receives request and creates parcel in their database,
    // but the socket drops on the initial request (including in-flight retries) so BoutiqFlow receives a timeout.
    sandboxAdapter.timeoutCountOnCreate = 4;

    let initialError = null;
    try {
      await db.withTenant({ tenantId }, async (tx) => {
        await ShipmentService.createShipment(tx, {
          orderId,
          provider: DELIVERY_PROVIDERS.SANDBOX,
          operationId,
          adapterOverride: sandboxAdapter
        });
      });
    } catch (err) {
      initialError = err;
    }

    assert.ok(initialError, 'Initial create timed out as simulated');

    // Verify parcel was indeed created on provider
    assert.strictEqual(sandboxAdapter.parcels.size, 1, 'Provider created parcel on initial attempt');
    const firstProviderParcel = Array.from(sandboxAdapter.parcels.values())[0];
    const initialTracking = firstProviderParcel.trackingNumber;

    // BoutiqFlow client retries 10 times with the same operationId
    const retryResults = [];
    for (let i = 0; i < 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await ShipmentService.createShipment(tx, {
          orderId,
          provider: DELIVERY_PROVIDERS.SANDBOX,
          operationId,
          adapterOverride: sandboxAdapter
        });
        retryResults.push(res);
      });
    }

    // Verify all 10 retries safely returned the recovered shipment
    assert.strictEqual(retryResults.length, 10);
    for (const res of retryResults) {
      assert.strictEqual(res.tracking_number, initialTracking, 'Tracking number matches');
      assert.strictEqual(res.isDuplicate, true, 'Marked as duplicate/recovered');
      assert.strictEqual(res.replayed, true);
    }

    // Strict Invariant Checks (INV-07-04, INV-07-08):
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Exactly 1 local shipment in DB
      const localShipments = await tx.query('shipments', s => s.tenant_id === tenantId && s.order_id === orderId);
      assert.strictEqual(localShipments.length, 1, 'Exactly 1 local shipment record exists in database');
      assert.strictEqual(localShipments[0].tracking_number, initialTracking);

      // 2. Exactly 1 provider parcel on carrier side
      assert.strictEqual(sandboxAdapter.parcels.size, 1, 'Carrier has exactly 1 parcel (zero duplicate parcels created)');

      // 3. Exactly 0 duplicate reservations
      const reservations = await tx.query('stock_reservations', r => r.order_id === orderId && r.tenant_id === tenantId);
      assert.strictEqual(reservations.length, 1, 'Exactly 1 reservation exists');

      // 4. Exactly 0 inventory mutations (still 10 on hand, 2 reserved)
      const level = await tx.query('stock_levels', sl => sl.variant_id === variantId && sl.location_id === locationId);
      assert.strictEqual(level[0].on_hand, 10, 'On hand unchanged');
      assert.strictEqual(level[0].reserved, 2, 'Reserved stock unchanged');
    });
  });

  await t.test('INV-07-17: Bounded retry succeeds after transient 503 failures', async () => {
    let order2 = null;
    await db.withTenant({ tenantId }, async (tx) => {
      order2 = await createOnlineOrder(tx, {
        customerName: 'Kenza T.',
        customerPhone: '0555112233',
        wilaya: 'Alger',
        commune: 'Bab Ezzouar',
        address: 'Cite Universitaire',
        items: [{ variantId, quantity: 1 }]
      });
      await CodConfirmationService.confirmAndReserve(tx, { orderId: order2.id, locationId });
    });

    const retryAdapter = new FakeDeliveryProvider({ id: 'acc-sbx-retry' });
    // Fail 2 times with 503, succeed on 3rd attempt
    retryAdapter.failCountOnNextCreate = 2;

    let shipment = null;
    await db.withTenant({ tenantId }, async (tx) => {
      shipment = await ShipmentService.createShipment(tx, {
        orderId: order2.id,
        provider: DELIVERY_PROVIDERS.SANDBOX,
        adapterOverride: retryAdapter
      });
    });

    assert.ok(shipment, 'Shipment successfully created after retry');
    assert.strictEqual(retryAdapter.createAttempts, 3, 'Took exactly 3 attempts (2 transient failures + 1 success)');
  });
});
