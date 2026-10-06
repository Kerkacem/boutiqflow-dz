const test = require('node:test');
const assert = require('node:assert');
const {
  ShopifyGraphQLAdapter,
  signHmacSha256
} = require('../src/integrations');

test('Phase 10 — Shopify Webhook Authenticity & Normalization (INV-10-19, INV-10-20)', async (t) => {
  const adapter = new ShopifyGraphQLAdapter();
  const webhookSecret = 'shopify_shared_webhook_secret_999';

  await t.test('1. Validates HMAC-SHA256 signature in Base64 (INV-10-19)', () => {
    const rawPayload = JSON.stringify({ id: 123456789, email: 'buyer@example.com' });
    const validSignature = signHmacSha256(rawPayload, webhookSecret, 'base64');

    const isValid = adapter.verifyWebhookSignature(rawPayload, {
      'x-shopify-hmac-sha256': validSignature
    }, webhookSecret);

    assert.strictEqual(isValid, true);

    const isTampered = adapter.verifyWebhookSignature(rawPayload + 'tampered', {
      'x-shopify-hmac-sha256': validSignature
    }, webhookSecret);

    assert.strictEqual(isTampered, false);

    const isWrongSecret = adapter.verifyWebhookSignature(rawPayload, {
      'x-shopify-hmac-sha256': validSignature
    }, 'wrong_secret');

    assert.strictEqual(isWrongSecret, false);
  });

  await t.test('2. Normalizes inbound Shopify order into canonical BoutiqFlow order representation', async () => {
    const rawOrder = {
      id: 88776655,
      order_number: 1042,
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      gateway: 'cib_edahabia_online',
      currency: 'DZD',
      total_price: '7500.00',
      total_shipping_price_set: {
        shop_money: { amount: '600.00', currency: 'DZD' }
      },
      customer: {
        first_name: 'Amine',
        last_name: 'Benali',
        phone: '0555123456'
      },
      shipping_address: {
        name: 'Amine Benali',
        phone: '0555123456',
        address1: '12 Rue Didouche Mourad',
        city: 'Alger Centre',
        province: 'Alger'
      },
      line_items: [
        {
          id: 111222,
          variant_id: 333444,
          title: 'Abaya Soie de Médine - Noir',
          sku: 'ABY-NOIR-M',
          quantity: 2,
          price: '3450.00'
        }
      ]
    };

    const normalized = await adapter.normalizeOrder(rawOrder);

    assert.strictEqual(normalized.externalOrderId, '88776655');
    assert.strictEqual(normalized.orderNumber, '#1042');
    assert.strictEqual(normalized.customerName, 'Amine Benali');
    assert.strictEqual(normalized.customerPhone, '0555123456');
    assert.strictEqual(normalized.wilaya, 'Alger');
    assert.strictEqual(normalized.commune, 'Alger Centre');
    assert.strictEqual(normalized.totalCentimes, 750000n);
    assert.strictEqual(normalized.shippingFeeCentimes, 60000n);
    assert.strictEqual(normalized.paymentMode, 'ONLINE');
    assert.strictEqual(normalized.isPaidOnline, true);
    assert.strictEqual(normalized.items.length, 1);
    assert.strictEqual(normalized.items[0].sku, 'ABY-NOIR-M');
    assert.strictEqual(normalized.items[0].quantity, 2);
    assert.strictEqual(normalized.items[0].unitPriceCentimes, 345000n);
  });
});
