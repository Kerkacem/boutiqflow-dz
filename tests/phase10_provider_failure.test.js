const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  IntegrationService,
  ShopifyGraphQLAdapter,
  WooCommerceRestAdapter,
  OrderImportService,
  PROVIDERS,
  INTEGRATION_STATUSES,
  INTEGRATION_ERRORS
} = require('../src/integrations');

test('Phase 10 — Provider Failure & Capability Matrix Enforcement (INV-10-03, INV-10-14)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Unsupported capability fails explicitly with CAPABILITY_NOT_SUPPORTED (INV-10-14)', () => {
    const adapter = new ShopifyGraphQLAdapter();

    // Verify assertion helper throws on missing capability
    assert.throws(
      () => adapter.assertCapability('UNSUPPORTED_CUSTOM_FEATURE'),
      err => {
        assert.strictEqual(err.code, INTEGRATION_ERRORS.CAPABILITY_NOT_SUPPORTED);
        return true;
      }
    );
  });

  await t.test('2. Revoked integration immediately refuses further order imports (INV-10-03)', async () => {
    let integrationId = null;

    await db.withTenant({ tenantId }, async (tx) => {
      const itg = await IntegrationService.registerIntegration(tx, {
        provider: PROVIDERS.SHOPIFY,
        name: 'Temporary Store',
        credentials: {
          shopDomain: 'temp-store.myshopify.com',
          accessToken: 'shpat_temp_token'
        },
        scopes: ['read_orders', 'read_products', 'read_inventory']
      });
      integrationId = itg.id;

      // Revoke the integration
      await IntegrationService.revokeIntegration(tx, {
        integrationId,
        reason: 'Store closed by merchant'
      });

      const itgRecord = await IntegrationService.getIntegration(tx, integrationId);
      assert.strictEqual(itgRecord.status, INTEGRATION_STATUSES.REVOKED);
    });

    // Attempting import on revoked integration must fail
    await db.withTenant({ tenantId }, async (tx) => {
      await assert.rejects(
        async () => OrderImportService.importExternalOrder(tx, {
          integrationId,
          rawOrder: { id: 12345 }
        }),
        /has been revoked and cannot process imports/
      );
    });
  });

  await t.test('3. Negative inventory projection is rejected', async () => {
    const adapter = new ShopifyGraphQLAdapter();
    await assert.rejects(
      async () => adapter.pushInventoryProjection({
        externalInventoryItemId: 'item_1',
        availableQuantity: -5
      }),
      /Available quantity cannot be negative/
    );

    const wooAdapter = new WooCommerceRestAdapter();
    await assert.rejects(
      async () => wooAdapter.pushInventoryProjection({
        externalProductId: 100,
        availableQuantity: -1
      }),
      /Available quantity cannot be negative/
    );
  });
});
