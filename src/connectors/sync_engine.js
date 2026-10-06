const { createOnlineOrder, confirmOrder } = require('../orders/orders');
const { getOrCreateStockLevel } = require('../inventory/ledger');

/**
 * Channel Synchronization Engine for BoutiqFlow DZ
 * Enforces single source of truth:
 * - Inbound external orders generate BoutiqFlow DZ orders and reserve stock via the central ledger.
 * - Outbound stock changes notify connected channels to push current available stock.
 * - Unmapped products are queued into an observable triage list.
 */

class ChannelSyncEngine {
  constructor() {
    this.connectors = new Map(); // channelId -> connector instance
    this.syncJobs = [];
  }

  registerConnector(channelId, connector) {
    this.connectors.set(channelId, connector);
  }

  getConnector(channelId) {
    return this.connectors.get(channelId);
  }

  /**
   * Processes an incoming external order from a channel.
   * 1. Normalizes the order.
   * 2. If unmapped items exist, routes order to triage without reserving unmapped items.
   * 3. Creates the order in BoutiqFlow DZ.
   * 4. If autoReserve is set and locationId provided, reserves available stock atomically via confirmOrder.
   */
  async processInboundOrder(tx, channelId, rawPayload, options = {}) {
    const connector = this.connectors.get(channelId);
    if (!connector) {
      throw new Error(`No connector registered for channel ${channelId}`);
    }

    const normalized = await connector.normalizeOrder(tx, rawPayload);

    // Record sync job
    const jobId = `sync_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const syncJob = {
      jobId,
      channelId,
      externalOrderId: normalized.external_order_id,
      status: normalized.requires_manual_triage ? 'TRIAGE_REQUIRED' : 'SUCCESS',
      unmappedCount: normalized.unmapped_items.length,
      createdAt: new Date().toISOString()
    };
    this.syncJobs.push(syncJob);

    // If all items are mapped, create order in BoutiqFlow DZ
    let createdOrder = null;
    if (!normalized.requires_manual_triage && normalized.items.length > 0) {
      createdOrder = await createOnlineOrder(tx, {
        customerName: normalized.customer_name,
        customerPhone: normalized.customer_phone,
        wilaya: normalized.wilaya,
        commune: normalized.commune,
        address: normalized.address,
        source: normalized.source,
        shippingFeeCentimes: normalized.shipping_fee_centimes,
        items: normalized.items.map(item => ({
          variantId: item.variant_id,
          qty: item.qty,
          unitPriceCentimes: item.unit_price_centimes,
          costPriceCentimes: item.cost_price_centimes
        }))
      });

      // If status is CONFIRMED or autoReserve is set, confirm order to reserve stock in location
      if (options.autoReserve && options.locationId) {
        createdOrder = await confirmOrder(tx, createdOrder.id, options.locationId);
      }
    }

    return {
      syncJob,
      normalized,
      createdOrder,
      requiresTriage: normalized.requires_manual_triage
    };
  }

  /**
   * Broadcasts updated available stock to all connected channels for a variant.
   */
  async broadcastInventoryUpdate(tx, variantId, locationId) {
    const variants = await tx.query('product_variants', v => v.id === variantId);
    if (variants.length === 0) return { notified: 0 };
    const variant = variants[0];

    const level = await getOrCreateStockLevel(tx, variantId, locationId);
    const available = level.available;

    const results = [];
    for (const [channelId, connector] of this.connectors.entries()) {
      if (connector.isConnected) {
        try {
          const pushRes = await connector.pushInventory(variant.sku, available);
          results.push({ channelId, success: true, pushRes });
        } catch (err) {
          results.push({ channelId, success: false, error: err.message });
        }
      }
    }

    return { variantSku: variant.sku, available, results };
  }

  getSyncJobs() {
    return [...this.syncJobs];
  }
}

module.exports = { ChannelSyncEngine };
