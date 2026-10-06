const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  WebhookDeliveryService,
  INTEGRATION_ERRORS,
  verifyHmacSha256
} = require('../src/integrations');

test('Phase 10 — Webhook SSRF Security, HMAC Signing & Bounded Retries (INV-10-21, INV-10-22, INV-10-23)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. SSRF Protection strictly blocks loopback, cloud metadata, and RFC 1918 private IPs (INV-10-23)', async () => {
    const maliciousUrls = [
      'http://localhost/webhook',
      'http://127.0.0.1:8080/callback',
      'http://0.0.0.0/webhook',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://10.0.0.5/api',
      'http://172.16.0.10:3000/hook',
      'http://192.168.1.1/admin',
      'ftp://example.com/webhook',
      'file:///etc/passwd'
    ];

    await db.withTenant({ tenantId }, async (tx) => {
      for (const url of maliciousUrls) {
        await assert.rejects(
          async () => WebhookDeliveryService.registerSubscription(tx, { url }),
          err => {
            assert.strictEqual(err.code, INTEGRATION_ERRORS.SSRF_BLOCKED);
            return true;
          },
          `Expected SSRF blocking for destination: ${url}`
        );
      }
    });
  });

  await t.test('2. Allows valid public HTTPS destinations and signs outbound webhooks with HMAC-SHA256 (INV-10-21)', async () => {
    let sub = null;
    await db.withTenant({ tenantId }, async (tx) => {
      sub = await WebhookDeliveryService.registerSubscription(tx, {
        url: 'https://api.myclientstore.dz/webhooks/boutiqflow',
        events: ['order.created'],
        secret: 'webhook_shared_client_secret_xyz'
      });
      assert.ok(sub.id);
      assert.strictEqual(sub.active, true);
    });

    await db.withTenant({ tenantId }, async (tx) => {
      const payload = { orderId: 'ord_123', totalCentimes: 500000n };
      const delivery = await WebhookDeliveryService.deliverWebhook(tx, {
        subscriptionId: sub.id,
        event: 'order.created',
        payload
      });

      assert.strictEqual(delivery.success, true);
      assert.ok(delivery.headers['X-BoutiqFlow-Signature']);

      // Parse signature header: t=<timestamp>,v1=<signature>
      const sigHeader = delivery.headers['X-BoutiqFlow-Signature'];
      const timestamp = delivery.headers['X-BoutiqFlow-Timestamp'];
      const sigMatch = sigHeader.match(/v1=([a-f0-9]+)/);
      assert.ok(sigMatch);
      const signature = sigMatch[1];

      // Verify recipient can validate authenticity
      const expectedPayload = `${timestamp}.${JSON.stringify(payload, (k, v) => typeof v === 'bigint' ? v.toString() : v)}`;
      const verified = verifyHmacSha256(expectedPayload, signature, 'webhook_shared_client_secret_xyz', 'hex');
      assert.strictEqual(verified, true, 'Outbound webhook signature must verify correctly (INV-10-21)');
    });
  });

  await t.test('3. Bounded retries: disables failing webhook subscription after threshold (INV-10-22)', async () => {
    let subId = null;
    await db.withTenant({ tenantId }, async (tx) => {
      const sub = await WebhookDeliveryService.registerSubscription(tx, {
        url: 'https://failing-endpoint.dz/hook',
        secret: 'test_sec'
      });
      subId = sub.id;
    });

    // Simulate 5 consecutive network delivery failures
    for (let i = 0; i < 5; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        await WebhookDeliveryService.deliverWebhook(tx, {
          subscriptionId: subId,
          event: 'order.created',
          payload: { test: true },
          dispatcher: async () => {
            throw new Error('Connection refused / 503');
          }
        });
      });
    }

    await db.withTenant({ tenantId }, async (tx) => {
      const sub = await tx.findById('webhook_subscriptions', subId);
      assert.strictEqual(sub.active, false, 'Subscription must be deactivated after reaching max failures (INV-10-22)');
      assert.strictEqual(sub.failure_count, 5);
    });
  });
});
