const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { MahalDatabase } = require('../src/db/client');
const { ShopifyConnector } = require('../src/connectors/shopify');
const { WooCommerceConnector } = require('../src/connectors/woocommerce');
const { ChannelSyncEngine } = require('../src/connectors/sync_engine');
const { applyStockMovement } = require('../src/inventory/ledger');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase 9 — Shopify & WooCommerce Channel Connectors & Central Inventory Sync', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let locationId;
  let variantM;
  let variantL;

  await t.test('Setup tenant, store location, and test clothing variants', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Magasin Alger Centre', is_store: true });
      locationId = loc.id;

      const prod = await tx.insert('products', { name: 'T-Shirt Basic DZ', category: 'T-Shirts' });
      variantM = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'TS-BASIC-BLK-M',
        barcode: '2000000000017',
        color: 'Noir',
        size: 'M',
        cost_price_centimes: 120000n, // 1200 DA
        selling_price_centimes: 250000n // 2500 DA
      });

      variantL = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'TS-BASIC-BLK-L',
        barcode: '2000000000024',
        color: 'Noir',
        size: 'L',
        cost_price_centimes: 120000n,
        selling_price_centimes: 250000n
      });

      // Initial Stock: 10 units of M in Shop
      await applyStockMovement(tx, {
        variantId: variantM.id,
        locationId,
        qty: 10,
        costPriceCentimes: 120000n,
        reason: 'OPENING_BALANCE'
      });
    });
  });

  await t.test('Shopify Connector: Credentials Validation & Webhook Signature Verification', async () => {
    const invalidConnector = new ShopifyConnector({
      tenantId,
      channelId: 'chan_shop_1',
      config: { shopName: 'invalid-domain.com', accessToken: 'shpat_123' }
    });
    const checkBad = await invalidConnector.validateCredentials();
    assert.strictEqual(checkBad.valid, false);

    const validConnector = new ShopifyConnector({
      tenantId,
      channelId: 'chan_shop_1',
      config: {
        shopName: 'boutique-dz.myshopify.com',
        accessToken: 'shpat_valid_token_xyz',
        webhookSecret: 'shpss_supersecret_webhook_key'
      }
    });
    const checkGood = await validConnector.validateCredentials();
    assert.strictEqual(checkGood.valid, true);

    const connectRes = await validConnector.connect();
    assert.strictEqual(connectRes.status, 'CONNECTED');

    // Test Webhook Signature
    const rawPayload = JSON.stringify({ id: 1001, test: true });
    const validHmac = crypto
      .createHmac('sha256', 'shpss_supersecret_webhook_key')
      .update(rawPayload, 'utf8')
      .digest('base64');

    assert.strictEqual(validConnector.verifyWebhookSignature(rawPayload, validHmac), true);
    assert.strictEqual(validConnector.verifyWebhookSignature(rawPayload, 'bad_hmac_signature'), false);
  });

  await t.test('Shopify Order Normalization & SKU-First Variant Mapping', async () => {
    const connector = new ShopifyConnector({
      tenantId,
      channelId: 'chan_shop_1',
      config: {
        shopName: 'boutique-dz.myshopify.com',
        accessToken: 'shpat_token',
        webhookSecret: 'shpss_secret'
      }
    });
    await connector.connect();

    await db.withTenant({ tenantId }, async (tx) => {
      const shopifyPayload = {
        id: 987654321,
        order_number: 1052,
        financial_status: 'authorized',
        fulfillment_status: null,
        total_price: '5500.00',
        total_shipping_price_set: {
          shop_money: { amount: '500.00' }
        },
        shipping_address: {
          first_name: 'Walid',
          last_name: 'Benali',
          phone: '0555 12 34 56',
          province: '16 - Alger',
          city: 'Kouba',
          address1: 'Rue des Frères Benali, Villa 12'
        },
        line_items: [
          {
            id: 111,
            title: 'T-Shirt Basic DZ - Noir / M',
            sku: 'TS-BASIC-BLK-M',
            quantity: 2,
            price: '2500.00'
          }
        ]
      };

      const normalized = await connector.normalizeOrder(tx, shopifyPayload);

      assert.strictEqual(normalized.source, 'SHOPIFY');
      assert.strictEqual(normalized.external_order_id, '987654321');
      assert.strictEqual(normalized.order_number, '1052');
      assert.strictEqual(normalized.customer_name, 'Walid Benali');
      assert.strictEqual(normalized.customer_phone, '+213555123456');
      assert.strictEqual(normalized.wilaya, '16 - Alger');
      assert.strictEqual(normalized.commune, 'Kouba');
      assert.strictEqual(normalized.total_centimes, 550000n);
      assert.strictEqual(normalized.shipping_fee_centimes, 50000n);
      assert.strictEqual(normalized.items.length, 1);
      assert.strictEqual(normalized.items[0].sku, 'TS-BASIC-BLK-M');
      assert.strictEqual(normalized.items[0].qty, 2);
      assert.strictEqual(normalized.requires_manual_triage, false);
    });
  });

  await t.test('Unmapped Item Triage: External order with unknown SKU isolates safely', async () => {
    const connector = new ShopifyConnector({
      tenantId,
      channelId: 'chan_shop_1',
      config: {
        shopName: 'boutique-dz.myshopify.com',
        accessToken: 'shpat_token'
      }
    });

    await db.withTenant({ tenantId }, async (tx) => {
      const payloadWithUnknownSku = {
        id: 987654322,
        order_number: 1053,
        total_price: '4000.00',
        shipping_address: {
          first_name: 'Amine',
          phone: '0661000000',
          city: 'Oran'
        },
        line_items: [
          {
            id: 222,
            title: 'Robe Soirée Satin (Unknown in BoutiqFlow)',
            sku: 'ROBE-UNKNOWN-RED-XL',
            quantity: 1,
            price: '4000.00'
          }
        ]
      };

      const normalized = await connector.normalizeOrder(tx, payloadWithUnknownSku);

      assert.strictEqual(normalized.requires_manual_triage, true);
      assert.strictEqual(normalized.unmapped_items.length, 1);
      assert.strictEqual(normalized.unmapped_items[0].sku, 'ROBE-UNKNOWN-RED-XL');
      assert.strictEqual(normalized.unmapped_items[0].reason, 'UNMATCHED_SKU');

      const unmappedList = connector.getUnmappedItems();
      assert.ok(unmappedList.length >= 1);
      assert.strictEqual(unmappedList[0].sku, 'ROBE-UNKNOWN-RED-XL');
    });
  });

  await t.test('WooCommerce Connector: Validation, Webhook & Order Parsing', async () => {
    const woo = new WooCommerceConnector({
      tenantId,
      channelId: 'chan_woo_1',
      config: {
        siteUrl: 'https://monboutique.dz',
        consumerKey: 'ck_1234567890abcdef',
        consumerSecret: 'cs_1234567890abcdef',
        webhookSecret: 'woo_webhook_secret'
      }
    });

    const check = await woo.validateCredentials();
    assert.strictEqual(check.valid, true);
    await woo.connect();

    // Verify Webhook Signature
    const rawBody = JSON.stringify({ id: 550, status: 'processing' });
    const signature = crypto
      .createHmac('sha256', 'woo_webhook_secret')
      .update(rawBody, 'utf8')
      .digest('base64');

    assert.strictEqual(woo.verifyWebhookSignature(rawBody, signature), true);
    assert.strictEqual(woo.verifyWebhookSignature(rawBody, 'wrong_signature'), false);

    // Normalize WooCommerce Order
    await db.withTenant({ tenantId }, async (tx) => {
      const wooPayload = {
        id: 550,
        number: '550',
        status: 'processing',
        total: '3100.00',
        shipping_total: '600.00',
        billing: {
          first_name: 'Karim',
          last_name: 'Dahmani',
          phone: '0770 11 22 33',
          state: '31 - Oran',
          city: 'Oran',
          address_1: 'Es Senia'
        },
        shipping: {
          first_name: 'Karim',
          last_name: 'Dahmani',
          state: '31 - Oran',
          city: 'Oran',
          address_1: 'Es Senia'
        },
        line_items: [
          {
            product_id: 88,
            name: 'T-Shirt Basic DZ',
            sku: 'TS-BASIC-BLK-L',
            quantity: 1,
            price: '2500.00'
          }
        ]
      };

      const normalized = await woo.normalizeOrder(tx, wooPayload);
      assert.strictEqual(normalized.source, 'WOOCOMMERCE');
      assert.strictEqual(normalized.status, 'CONFIRMED');
      assert.strictEqual(normalized.customer_name, 'Karim Dahmani');
      assert.strictEqual(normalized.customer_phone, '+213770112233');
      assert.strictEqual(normalized.wilaya, '31 - Oran');
      assert.strictEqual(normalized.items[0].sku, 'TS-BASIC-BLK-L');
      assert.strictEqual(normalized.requires_manual_triage, false);
    });
  });

  await t.test('ChannelSyncEngine: Inbound Order Creates BoutiqFlow Order & Reserves Stock via Central Ledger', async () => {
    const syncEngine = new ChannelSyncEngine();
    const shopify = new ShopifyConnector({
      tenantId,
      channelId: 'chan_shop_active',
      config: {
        shopName: 'active-store.myshopify.com',
        accessToken: 'token_abc'
      }
    });
    await shopify.connect();
    syncEngine.registerConnector('chan_shop_active', shopify);

    await db.withTenant({ tenantId }, async (tx) => {
      const orderPayload = {
        id: 888100,
        order_number: 2001,
        total_price: '2500.00',
        shipping_address: {
          first_name: 'Yacine',
          last_name: 'Belhadj',
          phone: '0560123456',
          province: '09 - Blida',
          city: 'Blida',
          address1: 'Centre Ville'
        },
        line_items: [
          {
            id: 99,
            title: 'T-Shirt Basic DZ',
            sku: 'TS-BASIC-BLK-M',
            quantity: 1,
            price: '2500.00'
          }
        ]
      };

      // Process inbound order with auto-reserve on Shop location
      const result = await syncEngine.processInboundOrder(tx, 'chan_shop_active', orderPayload, {
        autoReserve: true,
        locationId
      });

      assert.strictEqual(result.requiresTriage, false);
      assert.ok(result.createdOrder);
      assert.strictEqual(result.createdOrder.status, 'CONFIRMED');

      // Check Central Inventory Ledger Level:
      // on_hand: 10, reserved: 1, available: 9 (INV-2 strictly maintained)
      const levels = await tx.query('stock_levels', l => l.variant_id === variantM.id && l.location_id === locationId);
      assert.strictEqual(levels.length, 1);
      assert.strictEqual(levels[0].on_hand, 10);
      assert.strictEqual(levels[0].reserved, 1);
      assert.strictEqual(levels[0].available, 9);

      // Broadcast inventory update to channels
      const broadcastRes = await syncEngine.broadcastInventoryUpdate(tx, variantM.id, locationId);
      assert.strictEqual(broadcastRes.variantSku, 'TS-BASIC-BLK-M');
      assert.strictEqual(broadcastRes.available, 9);
      assert.strictEqual(broadcastRes.results[0].channelId, 'chan_shop_active');
      assert.strictEqual(broadcastRes.results[0].success, true);
    });
  });
});
