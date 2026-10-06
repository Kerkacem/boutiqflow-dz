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

test('Phase 07 — Webhook Idempotency & Raw Event Ledger Suite (INV-07-05)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let orderId = null;
  let shipment = null;

  await t.test('Setup tenant order and dispatch shipment', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Alger', type: 'shop' });
      const prod = await tx.insert('products', { name: 'Burnous Homme' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'BUR-HOM-BLANC-XL',
        size: 'XL',
        color: 'Blanc',
        cost_price: 600000n,
        sale_price: 1200000n
      });

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: loc.id,
        quantity: 10,
        movementType: 'IN',
        costPriceCentimes: 600000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      const ord = await createOnlineOrder(tx, {
        customerName: 'Yacine Brahimi',
        customerPhone: '0770998877',
        wilaya: 'Sétif',
        commune: 'El Eulma',
        address: 'Rue Dubai',
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

  await t.test('INV-07-05: Webhook Idempotency: Replaying same webhook 20 times produces exactly 1 event and 1 transition', async () => {
    const externalEventId = 'yal-evt-99887766';
    const payload = {
      status: 'en transit',
      rawStatus: 'en transit',
      timestamp: new Date().toISOString()
    };

    // Send webhook 20 times in sequence
    let firstResult = null;
    for (let i = 0; i < 20; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await ShipmentEventProcessor.processEvent(tx, {
          provider: DELIVERY_PROVIDERS.YALIDINE,
          rawPayload: payload,
          externalEventId,
          trackingNumber: shipment.tracking_number
        });

        if (i === 0) {
          firstResult = res;
          assert.strictEqual(res.isDuplicate, undefined);
          assert.strictEqual(res.canonicalStatus, SHIPMENT_STATUSES.IN_TRANSIT);
        } else {
          assert.strictEqual(res.isDuplicate, true, `Call #${i + 1} marked as duplicate`);
          assert.strictEqual(res.replayed, true);
          assert.strictEqual(res.providerEventId, firstResult.providerEventId);
        }
      });
    }

    // Verify exactly 1 record exists in provider_events
    await db.withTenant({ tenantId }, async (tx) => {
      const events = await tx.query('provider_events', e =>
        e.tenant_id === tenantId && e.external_event_id === externalEventId
      );
      assert.strictEqual(events.length, 1, 'Exactly one provider event recorded in ledger');

      const updatedShipment = await tx.findById('shipments', shipment.id);
      assert.strictEqual(updatedShipment.status, SHIPMENT_STATUSES.IN_TRANSIT);
    });
  });

  await t.test('Payload Hash Deduplication when externalEventId is omitted', async () => {
    const payload = {
      status: 'sorti pour livraison',
      rawStatus: 'sorti pour livraison',
      fixedNonce: 'static-nonce-12345'
    };

    for (let i = 0; i < 5; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await ShipmentEventProcessor.processEvent(tx, {
          provider: DELIVERY_PROVIDERS.YALIDINE,
          rawPayload: payload,
          trackingNumber: shipment.tracking_number
        });

        if (i === 0) {
          assert.strictEqual(res.canonicalStatus, SHIPMENT_STATUSES.OUT_FOR_DELIVERY);
        } else {
          assert.strictEqual(res.isDuplicate, true);
        }
      });
    }

    await db.withTenant({ tenantId }, async (tx) => {
      const updatedShipment = await tx.findById('shipments', shipment.id);
      assert.strictEqual(updatedShipment.status, SHIPMENT_STATUSES.OUT_FOR_DELIVERY);
    });
  });

  await t.test('INV-07-05: provider_events ledger is strictly append-only (cannot update or delete)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const events = await tx.query('provider_events', e => e.tenant_id === tenantId);
      assert.ok(events.length >= 1, 'Provider events exist');
      const eventId = events[0].id;

      // Update attempt rejected
      await assert.rejects(
        async () => {
          await tx.update('provider_events', eventId, {
            raw_status: 'tampered_status'
          });
        },
        /Audit Trail Violation: provider_events records are strictly immutable and append-only/
      );

      // Delete attempt rejected
      await assert.rejects(
        async () => {
          await tx.delete('provider_events', eventId);
        },
        /Audit Trail Violation: provider_events records cannot be deleted/
      );
    });
  });
});
