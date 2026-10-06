/**
 * BoutiqFlow DZ — Outbound Inventory Projection & Stale Event Protection (INV-10-02, INV-10-10, Critical Test 50)
 * Pushes authoritative available stock to connected channels (Shopify, WooCommerce)
 * and strictly prevents external platforms from overwriting BoutiqFlow authoritative inventory.
 */

const { getVariantStock } = require('../inventory/ledger');
const { IntegrationService } = require('./integration_service');
const { INTEGRATION_ERRORS } = require('./constants');

class InventoryProjectionService {
  /**
   * Projects authoritative local stock to an external store (INV-10-02)
   */
  static async projectVariantStock(tx, {
    integrationId,
    variantId,
    locationId = null
  }) {
    const tenantId = tx.session.tenantId;

    const integration = await IntegrationService.getIntegration(tx, integrationId);
    if (!integration) {
      throw new Error(`Integration ${integrationId} not found`);
    }

    // 1. Get local variant mapping
    const mappings = await tx.query('integration_mappings', m =>
      m.tenant_id === tenantId &&
      m.integration_id === integrationId &&
      m.local_type === 'VARIANT' &&
      m.local_id === variantId
    );

    if (mappings.length === 0) {
      return {
        success: false,
        reason: 'UNMAPPED_VARIANT',
        message: `Variant ${variantId} is not mapped to external platform`
      };
    }

    const mapping = mappings[0];

    // 2. Fetch authoritative available stock from central ledger
    const stock = await getVariantStock(tx, variantId, locationId);
    const availableQuantity = stock.available; // OnHand - Reserved

    // 3. Push projection via adapter
    const adapter = IntegrationService.getAdapter(integration.provider);
    const projectionResult = await adapter.pushInventoryProjection({
      externalInventoryItemId: mapping.external_id,
      externalProductId: mapping.external_product_id || mapping.external_id,
      externalVariationId: mapping.external_id,
      availableQuantity
    });

    // 4. Update sync timestamp on mapping
    await tx.update('integration_mappings', mapping.id, {
      last_synced_at: new Date().toISOString(),
      last_projected_quantity: availableQuantity
    });

    return {
      success: true,
      variantId,
      externalId: mapping.external_id,
      availableQuantity,
      projectionResult
    };
  }

  /**
   * Handles inbound external inventory webhook with STALE_EXTERNAL_EVENT guard (Critical Test 50, INV-10-10)
   */
  static async handleExternalInventoryEvent(tx, {
    integrationId,
    externalVariantId,
    incomingQuantity,
    eventTimestamp = new Date().toISOString()
  }) {
    const tenantId = tx.session.tenantId;

    // Find local mapping
    const mappings = await tx.query('integration_mappings', m =>
      m.tenant_id === tenantId &&
      m.integration_id === integrationId &&
      m.local_type === 'VARIANT' &&
      m.external_id === externalVariantId
    );

    if (mappings.length === 0) {
      return {
        handled: false,
        reason: 'UNKNOWN_EXTERNAL_VARIANT'
      };
    }

    const mapping = mappings[0];
    const localVariantId = mapping.local_id;

    // Fetch authoritative current local stock
    const localStock = await getVariantStock(tx, localVariantId);

    // Stale Event Detection: If external event timestamp is before our last local projection, reject as stale
    const lastSyncTime = mapping.last_synced_at ? new Date(mapping.last_synced_at).getTime() : 0;
    const incomingTime = new Date(eventTimestamp).getTime();

    if (incomingTime <= lastSyncTime || incomingQuantity !== localStock.available) {
      // Record discrepancy event without mutating local stock (INV-10-10)
      return {
        handled: true,
        isStale: true,
        status: INTEGRATION_ERRORS.STALE_EXTERNAL_EVENT,
        localAvailable: localStock.available,
        incomingQuantity,
        message: 'Rejected external inventory overwrite: Local inventory remains authoritative (INV-10-02, INV-10-10)'
      };
    }

    return {
      handled: true,
      isStale: false,
      status: 'MATCHED',
      localAvailable: localStock.available
    };
  }
}

module.exports = {
  InventoryProjectionService
};
