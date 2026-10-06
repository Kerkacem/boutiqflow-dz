/**
 * BoutiqFlow DZ — Base Commerce Adapter Interface (INV-10-13, INV-10-14)
 * Defines the canonical contract for e-commerce platforms (Shopify, WooCommerce).
 * Enforces explicit capability checks with zero silent failures.
 */

const { CAPABILITIES, INTEGRATION_ERRORS } = require('../constants');

class BaseCommerceAdapter {
  constructor({ provider, apiVersion = null, capabilities = [] } = {}) {
    if (!provider) throw new Error('CommerceAdapter Error: provider is required');
    this.provider = provider;
    this.apiVersion = apiVersion;
    this.capabilities = new Set(capabilities);
  }

  hasCapability(capability) {
    return this.capabilities.has(capability);
  }

  assertCapability(capability) {
    if (!this.hasCapability(capability)) {
      const err = new Error(`Provider '${this.provider}' does not support capability '${capability}' (INV-10-14)`);
      err.code = INTEGRATION_ERRORS.CAPABILITY_NOT_SUPPORTED;
      throw err;
    }
  }

  async validateCredentials(credentials) {
    throw new Error('validateCredentials must be implemented by adapter');
  }

  async normalizeOrder(rawPayload) {
    throw new Error('normalizeOrder must be implemented by adapter');
  }

  async pushInventoryProjection(params) {
    this.assertCapability(CAPABILITIES.INVENTORY_WRITE);
    throw new Error('pushInventoryProjection must be implemented by adapter');
  }

  async createFulfillment(params) {
    this.assertCapability(CAPABILITIES.FULFILLMENT_WRITE);
    throw new Error('createFulfillment must be implemented by adapter');
  }

  verifyWebhookSignature(rawBody, headers, secret) {
    this.assertCapability(CAPABILITIES.WEBHOOKS);
    throw new Error('verifyWebhookSignature must be implemented by adapter');
  }
}

module.exports = {
  BaseCommerceAdapter
};
