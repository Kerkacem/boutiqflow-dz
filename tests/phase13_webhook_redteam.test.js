const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { verifyHmacSha256 } = require('../src/integrations');
const {
  ShipmentEventProcessor,
  DELIVERY_PROVIDERS,
  SHIPMENT_STATUSES
} = require('../src/delivery');

test('Phase 13 — Inbound Webhook Red Team & Forgery Attacks (INV-13-20, Requirement 74)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Invalid HMAC-SHA256 signature is strictly rejected before processing (Requirement 74)', () => {
    const secret = 'webhook_secret_key_algeria_2026';
    const rawPayload = JSON.stringify({ event: 'order.updated', id: 12345 });

    // Forged signature
    const badSignature = 'invalidsignaturebase64==';
    const isValid = verifyHmacSha256(rawPayload, badSignature, secret);
    assert.strictEqual(isValid, false);
  });

  await t.test('2. Carrier webhook with duplicate eventId produces exactly 1 transition (INV-13-20)', async () => {
    const trackingNumber = 'YAL-DUP-TEST-001';

    await db.withTenant({ tenantId }, async (tx) => {
      // Create confirmed order & shipment
      const order = await tx.insert('online_orders', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        status: 'SHIPPED',
        total_centimes: 600000n
      });

      await tx.insert('shipments', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        order_id: order.id,
        tracking_number: trackingNumber,
        provider: DELIVERY_PROVIDERS.YALIDINE,
        status: SHIPMENT_STATUSES.ACCEPTED
      });
    });

    const eventPayload = {
      status: 'en transit',
      rawStatus: 'en transit',
      timestamp: new Date().toISOString()
    };

    // Send webhook 10 times concurrently / repeatedly
    const results = [];
    for (let i = 0; i < 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await ShipmentEventProcessor.processEvent(tx, {
          provider: DELIVERY_PROVIDERS.YALIDINE,
          rawPayload: eventPayload,
          externalEventId: 'YAL-EVT-DUP-999',
          trackingNumber
        });
        results.push(res);
      });
    }

    // Exactly 1 processed, 9 marked duplicate
    const first = results[0];
    assert.strictEqual(first.isDuplicate, undefined);

    for (let i = 1; i < 10; i++) {
      assert.strictEqual(results[i].isDuplicate, true);
      assert.strictEqual(results[i].replayed, true);
    }

    // Verify DB: exactly 1 provider event
    await db.withTenant({ tenantId }, async (tx) => {
      const events = await tx.query('provider_events', e => e.external_event_id === 'YAL-EVT-DUP-999');
      assert.strictEqual(events.length, 1);
    });
  });
});
