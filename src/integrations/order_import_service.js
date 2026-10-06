/**
 * BoutiqFlow DZ — Idempotent External Order Import Service (INV-10-06, INV-10-24, Critical Test 49)
 * Normalizes inbound orders from Shopify/WooCommerce, maps them to canonical OnlineOrders,
 * manages unmapped product triage, and prevents duplicate creations under webhook retries.
 */

const { generateUUIDv7 } = require('../db/utils');
const { createOnlineOrder, confirmOrder } = require('../orders/orders');
const { IntegrationService } = require('./integration_service');
const { computePayloadHash } = require('./crypto_service');
const { INTEGRATION_STATUSES } = require('./constants');

class OrderImportService {
  /**
   * Imports an external order idempotently (INV-10-06, Critical Test 49)
   */
  static async importExternalOrder(tx, {
    integrationId,
    rawOrder,
    autoConfirm = false,
    locationId = null
  }) {
    const tenantId = tx.session.tenantId;

    // 1. Verify integration is active
    const integration = await IntegrationService.getIntegration(tx, integrationId);
    if (!integration) {
      throw new Error(`Integration ${integrationId} not found or foreign tenant (INV-10-03)`);
    }

    if (integration.status === INTEGRATION_STATUSES.REVOKED) {
      throw new Error(`Integration ${integrationId} has been revoked and cannot process imports (INV-10-03)`);
    }

    // 2. Normalize raw external order using provider adapter
    const adapter = IntegrationService.getAdapter(integration.provider);
    const normalized = await adapter.normalizeOrder(rawOrder);
    const payloadHash = computePayloadHash(rawOrder);

    // 3. Exact Idempotency Check (INV-10-06, Critical Test 49)
    const existingMappings = await tx.query('integration_mappings', m =>
      m.tenant_id === tenantId &&
      m.integration_id === integrationId &&
      m.local_type === 'ORDER' &&
      m.external_id === normalized.externalOrderId
    );

    if (existingMappings.length > 0) {
      const mapping = existingMappings[0];
      const existingOrder = await tx.findById('online_orders', mapping.local_id);

      // Record duplicate event in integration_events as REPLAYED
      await tx.insert('integration_events', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        integration_id: integrationId,
        provider: integration.provider,
        external_event_id: `replayed_${normalized.externalOrderId}_${Date.now()}`,
        topic: 'orders/create',
        payload_hash: payloadHash,
        status: 'REPLAYED',
        received_at: new Date().toISOString(),
        processed_at: new Date().toISOString()
      });

      return {
        replayed: true,
        orderId: mapping.local_id,
        order: existingOrder,
        message: 'Order already imported idempotently (INV-10-06)'
      };
    }

    // 4. Map line items to local product variants
    const mappedItems = [];
    const unmappedItems = [];

    for (const item of normalized.items) {
      let localVariant = null;

      // Try SKU lookup
      if (item.sku) {
        const variants = await tx.query('product_variants', v =>
          v.tenant_id === tenantId && v.sku === item.sku
        );
        if (variants.length > 0) localVariant = variants[0];
      }

      // Try external variant mapping if not found by SKU
      if (!localVariant && item.externalVariantId) {
        const varMappings = await tx.query('integration_mappings', m =>
          m.tenant_id === tenantId &&
          m.integration_id === integrationId &&
          m.local_type === 'VARIANT' &&
          m.external_id === item.externalVariantId
        );
        if (varMappings.length > 0) {
          localVariant = await tx.findById('product_variants', varMappings[0].local_id);
        }
      }

      if (localVariant) {
        mappedItems.push({
          variantId: localVariant.id,
          productName: item.title,
          sku: localVariant.sku,
          quantity: item.quantity,
          unitPriceCentimes: item.unitPriceCentimes
        });
      } else {
        unmappedItems.push(item);
      }
    }

    // If unmapped items exist, store in unmapped_items triage without failing the import
    if (unmappedItems.length > 0) {
      for (const unmapped of unmappedItems) {
        await tx.insert('unmapped_items', {
          id: generateUUIDv7(),
          tenant_id: tenantId,
          integration_id: integrationId,
          external_order_id: normalized.externalOrderId,
          external_sku: unmapped.sku,
          external_title: unmapped.title,
          quantity: unmapped.quantity,
          status: 'PENDING_TRIAGE',
          created_at: new Date().toISOString()
        });
      }
    }

    // 5. Create canonical OnlineOrder in domain
    const orderRecord = await createOnlineOrder(tx, {
      customerName: normalized.customerName,
      customerPhone: normalized.customerPhone,
      wilaya: normalized.wilaya,
      commune: normalized.commune,
      address: normalized.address,
      items: mappedItems,
      deliveryFeeCentimes: normalized.shippingFeeCentimes,
      channel: integration.provider,
      metadata: {
        externalOrderId: normalized.externalOrderId,
        orderNumber: normalized.orderNumber,
        isPaidOnline: normalized.isPaidOnline,
        paymentMode: normalized.paymentMode,
        hasUnmappedItems: unmappedItems.length > 0
      }
    });

    // 6. Section 24 & INV-10-24: If paid online, record evidence on order without mutating Cash Register
    if (normalized.isPaidOnline) {
      await tx.update('online_orders', orderRecord.id, {
        is_paid_online: true,
        payment_status: 'PAID_ONLINE',
        paid_online_at: new Date().toISOString()
      });
      // Verification: Zero mutations are performed on cash_registers or cash_transactions (INV-10-24)
    }

    // 7. Auto-confirm if requested and location provided
    if (autoConfirm && locationId && mappedItems.length > 0) {
      try {
        await confirmOrder(tx, {
          orderId: orderRecord.id,
          locationId
        });
      } catch (err) {
        // Confirmation / reservation failed due to stock; leaves order in NEW
      }
    }

    // 8. Create mapping in integration_mappings
    await tx.insert('integration_mappings', {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      integration_id: integrationId,
      local_type: 'ORDER',
      local_id: orderRecord.id,
      external_type: 'EXTERNAL_ORDER',
      external_id: normalized.externalOrderId,
      last_synced_at: new Date().toISOString()
    });

    // 9. Record event in append-only integration_events log
    await tx.insert('integration_events', {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      integration_id: integrationId,
      provider: integration.provider,
      external_event_id: normalized.externalOrderId,
      topic: 'orders/create',
      payload_hash: payloadHash,
      status: 'PROCESSED',
      received_at: new Date().toISOString(),
      processed_at: new Date().toISOString()
    });

    return {
      replayed: false,
      orderId: orderRecord.id,
      order: orderRecord,
      unmappedItemsCount: unmappedItems.length
    };
  }
}

module.exports = {
  OrderImportService
};
