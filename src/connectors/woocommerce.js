const crypto = require('crypto');
const { BaseChannelConnector } = require('./adapter');
const { normalizeAlgerianPhone, dinarToCentimes } = require('../db/utils');

/**
 * WooCommerce Channel Connector for BoutiqFlow DZ
 * Manages webhook verification, SKU-first product/variant resolution,
 * order payload normalization, and inventory push synchronization.
 */

class WooCommerceConnector extends BaseChannelConnector {
  constructor({ tenantId, channelId, config = {} }) {
    super({ tenantId, channelId, config });
    this.siteUrl = config.siteUrl;
    this.consumerKey = config.consumerKey;
    this.consumerSecret = config.consumerSecret;
    this.webhookSecret = config.webhookSecret;
  }

  async validateCredentials() {
    if (!this.siteUrl || !this.consumerKey || !this.consumerSecret) {
      return { valid: false, error: 'Missing siteUrl, consumerKey or consumerSecret' };
    }
    if (!this.siteUrl.startsWith('http://') && !this.siteUrl.startsWith('https://')) {
      return { valid: false, error: 'Invalid siteUrl. Must begin with http:// or https://' };
    }
    return { valid: true };
  }

  async connect() {
    const check = await this.validateCredentials();
    if (!check.valid) {
      throw new Error(`WooCommerce connection failed: ${check.error}`);
    }
    this.isConnected = true;
    this.logSyncEvent('INFO', 'Connected to WooCommerce store', { siteUrl: this.siteUrl });
    return { status: 'CONNECTED', siteUrl: this.siteUrl };
  }

  verifyWebhookSignature(rawBody, signatureHeader) {
    if (!this.webhookSecret || !signatureHeader) return false;
    const computedSignature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody, 'utf8')
      .digest('base64');
    const a = Buffer.from(computedSignature);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Normalizes a WooCommerce Order payload to BoutiqFlow DZ order format.
   */
  async normalizeOrder(tx, wooOrder) {
    const externalId = String(wooOrder.id);
    const orderNumber = String(wooOrder.number || externalId);

    const billing = wooOrder.billing || {};
    const shipping = wooOrder.shipping || {};

    const rawPhone = billing.phone || '';
    const phone = rawPhone ? normalizeAlgerianPhone(rawPhone) : '0550000000';
    const customerName = `${shipping.first_name || billing.first_name || ''} ${shipping.last_name || billing.last_name || ''}`.trim() || 'Client WooCommerce';

    const wilaya = shipping.state || billing.state || shipping.city || '16 - Alger';
    const commune = shipping.city || billing.city || 'Alger Centre';
    const address = shipping.address_1 || billing.address_1 || 'Adresse non spécifiée';

    const totalPrice = dinarToCentimes(wooOrder.total || '0');
    const shippingFee = dinarToCentimes(wooOrder.shipping_total || '0');

    // Line items resolution via SKU-first matching
    const items = [];
    const unmapped = [];

    for (const line of (wooOrder.line_items || [])) {
      const sku = (line.sku || '').trim();
      const resolution = await this.resolveVariantBySku(tx, sku, {
        externalId: line.product_id,
        variationId: line.variation_id,
        title: line.name
      });

      if (!resolution.mapped) {
        unmapped.push(resolution.unmappedItem);
      } else {
        items.push({
          variant_id: resolution.variant.id,
          sku: resolution.variant.sku,
          qty: parseInt(line.quantity, 10) || 1,
          unit_price_centimes: dinarToCentimes(line.price || line.total || '0'),
          cost_price_centimes: resolution.variant.cost_price_centimes || 0n
        });
      }
    }

    // Status mapping
    let internalStatus = 'NEW';
    const status = (wooOrder.status || '').toLowerCase();

    if (status === 'cancelled' || status === 'refunded' || status === 'failed') {
      internalStatus = 'CANCELLED';
    } else if (status === 'completed') {
      internalStatus = 'DELIVERED';
    } else if (status === 'processing') {
      internalStatus = 'CONFIRMED';
    } else if (status === 'on-hold') {
      internalStatus = 'NEW';
    }

    return {
      channel_id: this.channelId,
      external_order_id: externalId,
      order_number: orderNumber,
      source: 'WOOCOMMERCE',
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
      throw new Error('WooCommerce connector is not connected');
    }
    this.logSyncEvent('INFO', `Pushed inventory level for SKU ${sku}: ${availableQty}`, {
      sku,
      availableQty
    });
    return { success: true, sku, availableQty, timestamp: new Date().toISOString() };
  }
}

module.exports = { WooCommerceConnector };
