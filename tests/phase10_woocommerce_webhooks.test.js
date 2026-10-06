const test = require('node:test');
const assert = require('node:assert');
const {
  WooCommerceRestAdapter,
  signHmacSha256
} = require('../src/integrations');

test('Phase 10 — WooCommerce Webhook Signature & Order Normalization (INV-10-19)', async (t) => {
  const adapter = new WooCommerceRestAdapter();
  const secret = 'woo_secret_signature_key_444';

  await t.test('1. Validates HMAC-SHA256 signature in Base64 (INV-10-19)', () => {
    const rawPayload = JSON.stringify({ id: 5544, status: 'processing' });
    const validSig = signHmacSha256(rawPayload, secret, 'base64');

    const verified = adapter.verifyWebhookSignature(rawPayload, {
      'x-wc-webhook-signature': validSig
    }, secret);
    assert.strictEqual(verified, true);

    const tampered = adapter.verifyWebhookSignature(rawPayload + 'x', {
      'x-wc-webhook-signature': validSig
    }, secret);
    assert.strictEqual(tampered, false);
  });

  await t.test('2. Normalizes inbound WooCommerce COD and Online orders', async () => {
    const rawOrder = {
      id: 9912,
      number: '9912',
      status: 'processing',
      currency: 'DZD',
      total: '4500.00',
      shipping_total: '500.00',
      payment_method: 'cod',
      payment_method_title: 'Cash on Delivery',
      billing: {
        first_name: 'Karim',
        last_name: 'Ziani',
        phone: '0661223344',
        city: 'Constantine'
      },
      shipping: {
        first_name: 'Karim',
        last_name: 'Ziani',
        address_1: 'Zone Industrielle',
        address_2: 'Batiment B',
        city: 'Constantine',
        state: 'Constantine'
      },
      line_items: [
        {
          id: 771,
          product_id: 101,
          variation_id: 1012,
          name: 'Costume Homme - Bleu',
          sku: 'CST-BLEU-48',
          quantity: 1,
          price: '4000.00'
        }
      ]
    };

    const normalized = await adapter.normalizeOrder(rawOrder);
    assert.strictEqual(normalized.externalOrderId, '9912');
    assert.strictEqual(normalized.customerName, 'Karim Ziani');
    assert.strictEqual(normalized.customerPhone, '0661223344');
    assert.strictEqual(normalized.wilaya, 'Constantine');
    assert.strictEqual(normalized.commune, 'Constantine');
    assert.strictEqual(normalized.paymentMode, 'COD');
    assert.strictEqual(normalized.isPaidOnline, false);
    assert.strictEqual(normalized.totalCentimes, 450000n);
    assert.strictEqual(normalized.items[0].sku, 'CST-BLEU-48');
  });
});
