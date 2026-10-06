const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  WebhookDeliveryService,
  INTEGRATION_ERRORS
} = require('../src/integrations');

test('Phase 13 — Comprehensive SSRF Red Team Suite (Requirement 19)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. SSRF Filter Blocks Loopback, Cloud Metadata, Private RFC 1918 & Malformed Schemes (Requirement 19)', async () => {
    const dangerousUrls = [
      'http://localhost/admin',
      'http://127.0.0.1:9000/metrics',
      'http://127.0.0.2:80/',
      'http://0.0.0.0:8000',
      'http://[::1]/internal',
      'http://169.254.169.254/computeMetadata/v1/',
      'http://10.0.1.20/db',
      'http://172.20.0.5:5432/status',
      'http://192.168.100.1/gateway',
      'file:///etc/shadow',
      'gopher://127.0.0.1:6379/_flushall'
    ];

    await db.withTenant({ tenantId }, async (tx) => {
      for (const url of dangerousUrls) {
        await assert.rejects(
          async () => WebhookDeliveryService.registerSubscription(tx, { url }),
          (err) => {
            assert.strictEqual(err.code, INTEGRATION_ERRORS.SSRF_BLOCKED);
            return true;
          },
          `Expected SSRF blocking for ${url}`
        );
      }
    });
  });

  await t.test('2. Legitimate Public HTTPS Webhook URLs are permitted', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const validSub = await WebhookDeliveryService.registerSubscription(tx, {
        url: 'https://api.partner-courier.com/webhooks/deliveries',
        topics: ['order.shipped']
      });
      assert.ok(validSub.id);
      assert.strictEqual(validSub.url, 'https://api.partner-courier.com/webhooks/deliveries');
    });
  });
});
