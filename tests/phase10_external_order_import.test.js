const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  IntegrationService,
  OrderImportService,
  PROVIDERS
} = require('../src/integrations');

test('Phase 10 — Critical Order Import Test (INV-10-06, INV-10-24, Critical Test 49)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let integrationId = null;
  let variantId = null;
  let locationId = null;

  await t.test('Setup: Register Shopify Integration, create Product Variant & Inventory Location', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Dépôt Central Alger', type: 'warehouse' });
      locationId = loc.id;

      const prod = await tx.insert('products', { name: 'Djellaba Moderne', category: 'Femmes' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'DJL-MOD-42',
        barcode: '6131112223334',
        selling_price_cents: 800000n,
        attributes: { size: '42', color: 'Bleu' }
      });
      variantId = variant.id;

      const itg = await IntegrationService.registerIntegration(tx, {
        provider: PROVIDERS.SHOPIFY,
        name: 'Shopify Store Alger',
        credentials: {
          shopDomain: 'alger-boutique.myshopify.com',
          accessToken: 'shpat_alger_token_123'
        },
        scopes: ['read_orders', 'read_products', 'read_inventory']
      });
      integrationId = itg.id;
    });
  });

  await t.test('1. Shopify order #100 arrives via 20 webhooks + 5 polling calls -> exactly 1 logical OnlineOrder', async () => {
    const rawShopifyOrder100 = {
      id: 998877100,
      order_number: 100,
      financial_status: 'paid', // Paid Online
      gateway: 'cib_edahabia',
      currency: 'DZD',
      total_price: '8500.00',
      total_shipping_price_set: {
        shop_money: { amount: '500.00' }
      },
      customer: {
        first_name: 'Fatima',
        last_name: 'Mansouri',
        phone: '0551000100'
      },
      shipping_address: {
        name: 'Fatima Mansouri',
        phone: '0551000100',
        address1: 'Cité 500 Logements',
        city: 'Bab Ezzouar',
        province: 'Alger'
      },
      line_items: [
        {
          id: 501,
          variant_id: 601,
          title: 'Djellaba Moderne - Bleu - 42',
          sku: 'DJL-MOD-42',
          quantity: 1,
          price: '8000.00'
        }
      ]
    };

    let firstOrderId = null;

    // Simulate 20 Webhook calls (concurrent or sequential)
    for (let i = 0; i < 20; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await OrderImportService.importExternalOrder(tx, {
          integrationId,
          rawOrder: rawShopifyOrder100
        });

        if (i === 0) {
          assert.strictEqual(res.replayed, false);
          firstOrderId = res.orderId;
        } else {
          assert.strictEqual(res.replayed, true);
          assert.strictEqual(res.orderId, firstOrderId);
        }
      });
    }

    // Simulate 5 Polling queries picking up the same order
    for (let j = 0; j < 5; j++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await OrderImportService.importExternalOrder(tx, {
          integrationId,
          rawOrder: rawShopifyOrder100
        });
        assert.strictEqual(res.replayed, true);
        assert.strictEqual(res.orderId, firstOrderId);
      });
    }

    // Verification in Database:
    await db.withTenant({ tenantId }, async (tx) => {
      const orders = await tx.query('online_orders', o => o.tenant_id === tenantId);
      assert.strictEqual(orders.length, 1, 'MUST have exactly 1 logical OnlineOrder (INV-10-06)');
      assert.strictEqual(orders[0].id, firstOrderId);
      assert.strictEqual(orders[0].customer_name, 'Fatima Mansouri');
      assert.strictEqual(orders[0].is_paid_online, true);

      // Verify mapping
      const mappings = await tx.query('integration_mappings', m =>
        m.tenant_id === tenantId && m.integration_id === integrationId && m.local_id === firstOrderId
      );
      assert.strictEqual(mappings.length, 1, 'MUST have exactly 1 mapping record');

      // Verify Section 24 & INV-10-24: 0 cash register mutations for Paid Online orders
      const cashRegisters = await tx.query('cash_registers', () => true);
      const cashTransactions = await tx.query('cash_transactions', () => true);
      assert.strictEqual(cashTransactions.length, 0, 'Zero cash transactions allowed for online paid orders (INV-10-24)');
    });
  });
});
