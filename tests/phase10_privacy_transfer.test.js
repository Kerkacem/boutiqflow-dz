const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  IntegrationService,
  PROVIDERS
} = require('../src/integrations');

test('Phase 10 — International Data Transfer & Law 25-11 Audit Records (INV-10-24, INV-10-25)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Connecting foreign SaaS platform (Shopify) automatically logs statutory TransferRecord (INV-10-25)', async () => {
    let integration = null;
    await db.withTenant({ tenantId }, async (tx) => {
      integration = await IntegrationService.registerIntegration(tx, {
        provider: PROVIDERS.SHOPIFY,
        name: 'Shopify Store International',
        credentials: {
          shopDomain: 'store-dz.myshopify.com',
          accessToken: 'shpat_secret_intl_99'
        },
        scopes: ['read_orders', 'read_products', 'read_inventory']
      });

      // Verify Law 25-11 TransferRecord in database
      const transfers = await tx.query('transfer_records', r => r.integration_id === integration.id);
      assert.strictEqual(transfers.length, 1);
      assert.strictEqual(transfers[0].destination_country, 'CANADA');
      assert.strictEqual(transfers[0].recipient_legal_entity, 'Shopify Inc.');
      assert.strictEqual(transfers[0].transfer_status, 'AUTHORIZED_FOR_FULFILLMENT');
      assert.ok(transfers[0].safeguard_mechanism);
    });
  });

  await t.test('2. Audit log records integration connection without leaking plaintext credentials (INV-10-15)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const logs = await tx.query('audit_logs', l => l.action === 'INTEGRATION_CONNECTED');
      assert.strictEqual(logs.length, 1);
      const details = JSON.stringify(logs[0].details);
      assert.strictEqual(details.includes('shpat_secret_intl_99'), false, 'Credentials must never appear in audit logs (INV-10-15)');
    });
  });
});
