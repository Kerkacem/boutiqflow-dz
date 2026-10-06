/**
 * Base Channel Connector Interface for BoutiqFlow DZ
 * All external sales channels (Shopify, WooCommerce, Custom Storefronts, WhatsApp)
 * must implement this contract.
 *
 * Central Rule:
 * BoutiqFlow DZ central inventory ledger is the single source of truth.
 * External channels synchronize with central stock; they never overwrite it directly.
 */

class BaseChannelConnector {
  constructor({ tenantId, channelId, config = {} }) {
    if (!tenantId || !channelId) {
      throw new Error('Connector requires tenantId and channelId');
    }
    this.tenantId = tenantId;
    this.channelId = channelId;
    this.config = config;
    this.isConnected = false;
    this.syncLogs = [];
    this.unmappedItems = [];
  }

  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  async disconnect() {
    this.isConnected = false;
    return { status: 'DISCONNECTED', timestamp: new Date().toISOString() };
  }

  async validateCredentials() {
    throw new Error('validateCredentials() must be implemented by subclass');
  }

  /**
   * Maps an external SKU to an internal BoutiqFlow DZ Variant ID.
   * If no exact SKU match exists, it MUST NOT guess silently;
   * instead it records the item in UNMAPPED ITEMS.
   */
  async resolveVariantBySku(tx, externalSku, externalItemData = {}) {
    if (!externalSku || typeof externalSku !== 'string') {
      const unmapped = {
        channelId: this.channelId,
        externalId: externalItemData.externalId || null,
        title: externalItemData.title || 'Unknown Product',
        reason: 'MISSING_SKU',
        data: externalItemData,
        createdAt: new Date().toISOString()
      };
      this.unmappedItems.push(unmapped);
      return { mapped: false, unmappedItem: unmapped };
    }

    const variants = await tx.query('product_variants', v => v.sku === externalSku);
    if (variants.length === 0) {
      const unmapped = {
        channelId: this.channelId,
        sku: externalSku,
        externalId: externalItemData.externalId || null,
        title: externalItemData.title || externalSku,
        reason: 'UNMATCHED_SKU',
        data: externalItemData,
        createdAt: new Date().toISOString()
      };
      this.unmappedItems.push(unmapped);
      return { mapped: false, unmappedItem: unmapped };
    }

    return { mapped: true, variant: variants[0] };
  }

  /**
   * Normalizes external order payload into BoutiqFlow DZ Order structure.
   */
  async normalizeOrder(rawPayload) {
    throw new Error('normalizeOrder() must be implemented by subclass');
  }

  /**
   * Pushes available stock from BoutiqFlow DZ to the external channel.
   */
  async pushInventory(sku, availableQty) {
    throw new Error('pushInventory() must be implemented by subclass');
  }

  logSyncEvent(level, message, details = {}) {
    this.syncLogs.push({
      timestamp: new Date().toISOString(),
      level,
      message,
      details
    });
  }

  getUnmappedItems() {
    return [...this.unmappedItems];
  }

  clearResolvedUnmappedItem(sku) {
    this.unmappedItems = this.unmappedItems.filter(item => item.sku !== sku);
  }
}

module.exports = { BaseChannelConnector };
