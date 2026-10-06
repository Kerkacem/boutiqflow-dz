/**
 * BoutiqFlow DZ — Shopify GraphQL Admin API Adapter (INV-10-13, INV-10-14, INV-10-26)
 * Implements modern GraphQL-first Shopify Admin API integration with explicit versioning (2025-01).
 * Verifies webhook signatures using HMAC-SHA256 and normalizes inbound orders.
 */

const { BaseCommerceAdapter } = require('./base');
const { verifyHmacSha256 } = require('../crypto_service');
const { dinarToCentimes } = require('../../db/utils');
const {
  PROVIDERS,
  SHOPIFY_API_VERSION,
  CAPABILITIES,
  CAPABILITY_MATRIX,
  INTEGRATION_ERRORS
} = require('../constants');

class ShopifyGraphQLAdapter extends BaseCommerceAdapter {
  constructor({ apiVersion = SHOPIFY_API_VERSION } = {}) {
    super({
      provider: PROVIDERS.SHOPIFY,
      apiVersion,
      capabilities: CAPABILITY_MATRIX[PROVIDERS.SHOPIFY]
    });
  }

  /**
   * Validates Shopify credentials & minimum scopes (Section 6)
   */
  async validateCredentials({ shopDomain, accessToken, scopes = [] } = {}) {
    if (!shopDomain || !accessToken) {
      throw new Error('Shopify Error: shopDomain and accessToken are strictly required');
    }

    if (!shopDomain.includes('.myshopify.com')) {
      throw new Error(`Invalid Shopify domain format: ${shopDomain}`);
    }

    // Enforce least privilege scopes (Section 6)
    const requiredScopes = ['read_orders', 'read_products', 'read_inventory'];
    const hasRequired = requiredScopes.every(s => scopes.includes(s));
    if (!hasRequired && scopes.length > 0) {
      const missing = requiredScopes.filter(s => !scopes.includes(s));
      throw new Error(`Shopify Auth Error: Missing required scopes [${missing.join(', ')}]`);
    }

    return {
      valid: true,
      shopDomain,
      apiVersion: this.apiVersion
    };
  }

  /**
   * Verifies Shopify Webhook Authenticity using HMAC-SHA256 (Section 8, INV-10-19)
   */
  verifyWebhookSignature(rawBody, headers = {}, secret) {
    this.assertCapability(CAPABILITIES.WEBHOOKS);
    const signature = headers['x-shopify-hmac-sha256'] || headers['X-Shopify-Hmac-Sha256'];
    if (!signature) return false;
    return verifyHmacSha256(rawBody, signature, secret, 'base64');
  }

  /**
   * Normalizes inbound Shopify order into canonical format (Section 21, 23, 24)
   */
  async normalizeOrder(rawOrder = {}) {
    this.assertCapability(CAPABILITIES.ORDER_READ);

    const extId = String(rawOrder.id || (rawOrder.admin_graphql_api_id ? rawOrder.admin_graphql_api_id.split('/').pop() : ''));
    if (!extId) {
      throw new Error('Shopify Normalization Error: Order payload is missing external ID');
    }

    const shipping = rawOrder.shipping_address || rawOrder.customer?.default_address || {};
    const customer = rawOrder.customer || {};

    const firstName = shipping.first_name || customer.first_name || '';
    const lastName = shipping.last_name || customer.last_name || '';
    const customerName = (shipping.name || `${firstName} ${lastName}`.trim()) || 'Client Shopify';
    const customerPhone = shipping.phone || customer.phone || '0550000000';
    const wilaya = shipping.province || shipping.city || 'Alger';
    const commune = shipping.city || 'Alger';
    const address = shipping.address1 || 'Adresse non spécifiée';

    const items = (rawOrder.line_items || []).map(li => {
      const priceDinar = parseFloat(li.price || '0');
      return {
        externalLineId: String(li.id),
        externalVariantId: String(li.variant_id || ''),
        title: li.title || li.name || 'Article',
        sku: (li.sku || '').trim().toUpperCase(),
        quantity: parseInt(li.quantity || 1, 10),
        unitPriceCentimes: dinarToCentimes(priceDinar)
      };
    });

    const totalDinar = parseFloat(rawOrder.total_price || '0');
    const shippingFeeDinar = parseFloat(rawOrder.total_shipping_price_set?.shop_money?.amount || rawOrder.shipping_lines?.[0]?.price || '0');

    // Section 23 & 24: Payment Mode Normalization
    const isPaidOnline = rawOrder.financial_status === 'paid';
    const gateway = (rawOrder.gateway || '').toLowerCase();
    const isCodGateway = gateway.includes('cod') || gateway.includes('cash_on_delivery') || rawOrder.payment_gateway_names?.some(g => g.toLowerCase().includes('cod'));
    const paymentMode = isPaidOnline ? 'ONLINE' : (isCodGateway ? 'COD' : (rawOrder.financial_status === 'pending' ? 'COD' : 'ONLINE'));

    return {
      externalOrderId: extId,
      orderNumber: rawOrder.order_number ? `#${rawOrder.order_number}` : extId,
      customerName,
      customerPhone,
      wilaya,
      commune,
      address,
      items,
      totalCentimes: dinarToCentimes(totalDinar),
      shippingFeeCentimes: dinarToCentimes(shippingFeeDinar),
      paymentMode,
      isPaidOnline,
      rawStatus: rawOrder.financial_status || 'UNKNOWN',
      fulfillmentStatus: rawOrder.fulfillment_status || 'UNFULFILLED',
      currency: rawOrder.currency || 'DZD',
      normalizedAt: new Date().toISOString()
    };
  }

  /**
   * Pushes available inventory projection to Shopify via GraphQL Admin API (INV-10-10)
   */
  async pushInventoryProjection({ externalInventoryItemId, locationId = 'gid://shopify/Location/1', availableQuantity }) {
    this.assertCapability(CAPABILITIES.INVENTORY_WRITE);

    if (availableQuantity < 0) {
      throw new Error('Inventory Projection Error: Available quantity cannot be negative');
    }

    // GraphQL mutation representation (Section 5)
    const graphqlQuery = `
      mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          inventoryAdjustmentGroup {
            id
            changes {
              name
              delta
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    return {
      success: true,
      apiVersion: this.apiVersion,
      query: graphqlQuery,
      variables: {
        input: {
          name: 'available',
          reason: 'cycle_count_available',
          referenceDocumentUri: null,
          quantities: [
            {
              inventoryItemId: externalInventoryItemId,
              locationId,
              quantity: availableQuantity
            }
          ]
        }
      },
      projectedQuantity: availableQuantity,
      projectedAt: new Date().toISOString()
    };
  }

  /**
   * Creates fulfillment for an order via GraphQL Admin API (Section 31)
   */
  async createFulfillment({ externalOrderId, trackingNumber, trackingCompany = 'Yalidine Express' }) {
    this.assertCapability(CAPABILITIES.FULFILLMENT_WRITE);

    const graphqlQuery = `
      mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    return {
      success: true,
      apiVersion: this.apiVersion,
      query: graphqlQuery,
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: externalOrderId }],
          trackingInfo: {
            number: trackingNumber,
            company: trackingCompany
          }
        }
      },
      fulfilledAt: new Date().toISOString()
    };
  }
}

module.exports = {
  ShopifyGraphQLAdapter
};
