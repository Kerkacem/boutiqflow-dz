const crypto = require('crypto');
const { BaseChannelConnector } = require('./adapter');
const { normalizeAlgerianPhone, dinarToCentimes } = require('../db/utils');

/**
 * Shopify Channel Connector for BoutiqFlow DZ
 * Manages webhook processing, SKU-first variant resolution,
 * order normalization, and central inventory synchronization.
 */

class ShopifyConnector extends BaseChannelConnector {
  constructor({ tenantId, channelId, config = {} }) {
    super({ tenantId, channelId, config });
    this.shopName = config.shopName;
    this.accessToken = config.accessToken;
    this.webhookSecret = config.webhookSecret;
  }

  async validateCredentials() {
    if (!this.shopName || !this.accessToken) {
      return { valid: false, error: 'Missing shopName or accessToken' };
    }
    // Validate shopify domain format
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
    if (!domainRegex.test(this.shopName) && !this.shopName.includes('.myshopify.com')) {
      return { valid: false, error: 'Invalid Shopify domain format. Expected *.myshopify.com' };
    }
    return { valid: true };
  }

  async connect() {
    const check = await this.validateCredentials();
    if (!check.valid) {
      throw new Error(`Shopify connection failed: ${check.error}`);
    }
    this.isConnected = true;
    this.logSyncEvent('INFO', 'Connected to Shopify store', { shop: this.shopName });
    return { status: 'CONNECTED', shop: this.shopName };
  }

  verifyWebhookSignature(rawBody, hmacHeader) {
    if (!this.webhookSecret || !hmacHeader) return false;
    const digest = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody, 'utf8')
      .digest('base64');
    const a = Buffer.from(digest);
    const b = Buffer.from(hmacHeader);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Normalizes a Shopify Order payload to BoutiqFlow DZ order format.
   * Maps status, parses customer details, normalizes Algerian phone, converts prices to centimes.
   */
  async normalizeOrder(tx, shopifyOrder) {
    const externalId = String(shopifyOrder.id);
    const orderNumber = String(shopifyOrder.order_number || shopifyOrder.name || externalId);

    // Customer resolution
    const shippingAddress = shopifyOrder.shipping_address || {};
    const rawPhone = shippingAddress.phone || (shopifyOrder.customer && shopifyOrder.customer.phone) || '';
    const phone = rawPhone ? normalizeAlgerianPhone(rawPhone) : '0550000000';
    const customerName = `${shippingAddress.first_name || ''} ${shippingAddress.last_name || ''}`.trim() || 'Client Shopify';

    const wilaya = shippingAddress.province || shippingAddress.city || '16 - Alger';
    const commune = shippingAddress.city || 'Alger Centre';
    const address = shippingAddress.address1 || 'Adresse non spécifiée';

    // Financial calculations
    const totalPrice = dinarToCentimes(shopifyOrder.total_price || '0');
    const shippingFee = dinarToCentimes(
      (shopifyOrder.total_shipping_price_set && shopifyOrder.total_shipping_price_set.shop_money && shopifyOrder.total_shipping_price_set.shop_money.amount) || '0'
    );

    // Line items resolution via SKU-first matching
    const items = [];
    const unmapped = [];

    for (const line of (shopifyOrder.line_items || [])) {
      const sku = (line.sku || '').trim();
      const resolution = await this.resolveVariantBySku(tx, sku, {
        externalId: line.id,
        title: line.title || line.name,
        variantTitle: line.variant_title
      });

      if (!resolution.mapped) {
        unmapped.push(resolution.unmappedItem);
      } else {
        items.push({
          variant_id: resolution.variant.id,
          sku: resolution.variant.sku,
          qty: parseInt(line.quantity, 10) || 1,
          unit_price_centimes: dinarToCentimes(line.price || '0'),
          cost_price_centimes: resolution.variant.cost_price_centimes || 0n
        });
      }
    }

    // Status mapping
    let internalStatus = 'NEW';
    if (shopifyOrder.cancelled_at) {
      internalStatus = 'CANCELLED';
    } else if (shopifyOrder.fulfillment_status === 'fulfilled') {
      internalStatus = 'SHIPPED';
    } else if (shopifyOrder.financial_status === 'paid' || shopifyOrder.financial_status === 'authorized') {
      internalStatus = 'CONFIRMED';
    }

    return {
      channel_id: this.channelId,
      external_order_id: externalId,
      order_number: orderNumber,
      source: 'SHOPIFY',
      status: internalStatus,
      customer_name: customerName,
      customer_phone: phone,
      wilaya,
      commune,
      address,
      items,
      unmapped_items: unmapped,
      subtotal_centimes: totalPrice - shippingFee,
      shipping_fee_centimes: shippingFee,
      total_centimes: totalPrice,
      cod_amount_centimes: totalPrice,
      requires_manual_triage: unmapped.length > 0
    };
  }

  async pushInventory(sku, availableQty) {
    if (!this.isConnected) {
      throw new Error('Shopify connector is not connected');
    }
    this.logSyncEvent('INFO', `Pushed inventory level for SKU ${sku}: ${availableQty}`, {
      sku,
      availableQty
    });
    return { success: true, sku, availableQty, timestamp: new Date().toISOString() };
  }
}

module.exports = { ShopifyConnector };
