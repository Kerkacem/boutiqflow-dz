const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  IntegrationService,
  ShopifyGraphQLAdapter,
  PROVIDERS,
  INTEGRATION_STATUSES,
  SHOPIFY_API_VERSION
} = require('../src/integrations');

test('Phase 10 — Shopify Auth & Install Boundary (INV-10-03, INV-10-15, INV-10-26)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Validates Shopify GraphQL Admin API version is explicitly configured (2025-01)', () => {
    const adapter = new ShopifyGraphQLAdapter();
    assert.strictEqual(adapter.apiVersion, SHOPIFY_API_VERSION);
    assert.strictEqual(adapter.apiVersion, '2025-01');
  });

  await t.test('2. Rejects invalid Shopify domains or missing access tokens', async () => {
    const adapter = new ShopifyGraphQLAdapter();
    await assert.rejects(
      async () => adapter.validateCredentials({ shopDomain: 'malicious-domain.com', accessToken: 'shpat_123' }),
      /Invalid Shopify domain format/
    );
    await assert.rejects(
      async () => adapter.validateCredentials({ shopDomain: '', accessToken: 'shpat_123' }),
      /shopDomain and accessToken are strictly required/
    );
  });

  await t.test('3. Enforces minimum least-privilege scopes', async () => {
    const adapter = new ShopifyGraphQLAdapter();
    // Missing 'read_inventory'
    await assert.rejects(
      async () => adapter.validateCredentials({
        shopDomain: 'boutique-el-bahdja.myshopify.com',
        accessToken: 'shpat_123456789',
        scopes: ['read_orders', 'read_products']
      }),
      /Missing required scopes/
    );

    const valid = await adapter.validateCredentials({
      shopDomain: 'boutique-el-bahdja.myshopify.com',
      accessToken: 'shpat_123456789',
      scopes: ['read_orders', 'read_products', 'read_inventory']
    });
    assert.strictEqual(valid.valid, true);
    assert.strictEqual(valid.shopDomain, 'boutique-el-bahdja.myshopify.com');
  });

  await t.test('4. Registers integration, encrypts credentials at rest with AES-256-GCM (INV-10-15)', async () => {
    let integration = null;
    await db.withTenant({ tenantId }, async (tx) => {
      integration = await IntegrationService.registerIntegration(tx, {
        provider: PROVIDERS.SHOPIFY,
        name: 'Shopify Store Alger',
        credentials: {
          shopDomain: 'boutique-alger.myshopify.com',
          accessToken: 'shpat_secret_token_12345'
        },
        scopes: ['read_orders', 'read_products', 'read_inventory']
      });

      assert.ok(integration.id);
      assert.strictEqual(integration.provider, PROVIDERS.SHOPIFY);
      assert.strictEqual(integration.status, INTEGRATION_STATUSES.ACTIVE);
      assert.strictEqual(integration.api_version, SHOPIFY_API_VERSION);

      // Verify credentials are encrypted at rest in database
      const creds = await tx.query('integration_credentials', c => c.integration_id === integration.id);
      assert.strictEqual(creds.length, 1);
      assert.ok(creds[0].ciphertext);
      assert.ok(creds[0].iv);
      assert.ok(creds[0].tag);
      assert.strictEqual(creds[0].ciphertext.includes('shpat_secret_token_12345'), false, 'Raw token must not appear in DB');

      // Verify decrypted credentials
      const decrypted = await IntegrationService.getDecryptedCredentials(tx, integration.id);
      assert.strictEqual(decrypted.accessToken, 'shpat_secret_token_12345');
      assert.strictEqual(decrypted.shopDomain, 'boutique-alger.myshopify.com');
    });
  });

  await t.test('5. Tenant isolation: foreign tenant cannot access or decrypt credentials (INV-10-03)', async () => {
    const foreignTenantId = generateUUIDv7();
    let integrationId = null;

    await db.withTenant({ tenantId }, async (tx) => {
      const itg = await IntegrationService.registerIntegration(tx, {
        provider: PROVIDERS.SHOPIFY,
        name: 'Shopify Tenant A',
        credentials: {
          shopDomain: 'tenant-a.myshopify.com',
          accessToken: 'shpat_secret_a'
        },
        scopes: ['read_orders', 'read_products', 'read_inventory']
      });
      integrationId = itg.id;
    });

    await db.withTenant({ tenantId: foreignTenantId }, async (tx) => {
      const itg = await IntegrationService.getIntegration(tx, integrationId);
      assert.strictEqual(itg, null);

      await assert.rejects(
        async () => IntegrationService.getDecryptedCredentials(tx, integrationId),
        /No credentials found/
      );
    });
  });
});
