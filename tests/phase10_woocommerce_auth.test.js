const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  IntegrationService,
  WooCommerceRestAdapter,
  PROVIDERS,
  INTEGRATION_STATUSES,
  WOOCOMMERCE_API_PATH
} = require('../src/integrations');

test('Phase 10 — WooCommerce Auth & Registration (INV-10-03, INV-10-15)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Validates REST API v3 path and key formats', async () => {
    const adapter = new WooCommerceRestAdapter();
    assert.strictEqual(adapter.apiPath, WOOCOMMERCE_API_PATH);
    assert.strictEqual(adapter.apiPath, '/wp-json/wc/v3/');

    await assert.rejects(
      async () => adapter.validateCredentials({
        storeUrl: 'https://boutique-oran.dz',
        consumerKey: 'invalid_key',
        consumerSecret: 'cs_123'
      }),
      /Invalid WooCommerce API Key format/
    );

    const valid = await adapter.validateCredentials({
      storeUrl: 'https://boutique-oran.dz',
      consumerKey: 'ck_validkey123',
      consumerSecret: 'cs_validsecret456'
    });
    assert.strictEqual(valid.valid, true);
    assert.strictEqual(valid.apiEndpoint, 'https://boutique-oran.dz/wp-json/wc/v3/');
  });

  await t.test('2. Registers WooCommerce integration with AES-256-GCM encryption at rest', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const integration = await IntegrationService.registerIntegration(tx, {
        provider: PROVIDERS.WOOCOMMERCE,
        name: 'WooCommerce Oran Store',
        credentials: {
          storeUrl: 'https://oran-boutique.dz',
          consumerKey: 'ck_oran12345',
          consumerSecret: 'cs_oran67890'
        }
      });

      assert.ok(integration.id);
      assert.strictEqual(integration.provider, PROVIDERS.WOOCOMMERCE);
      assert.strictEqual(integration.status, INTEGRATION_STATUSES.ACTIVE);

      // Verify decrypted credentials
      const creds = await IntegrationService.getDecryptedCredentials(tx, integration.id);
      assert.strictEqual(creds.consumerKey, 'ck_oran12345');
      assert.strictEqual(creds.consumerSecret, 'cs_oran67890');
    });
  });
});
