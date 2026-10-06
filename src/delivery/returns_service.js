/**
 * BoutiqFlow DZ — Delivery Returns & Inspection Service (INV-07-12, INV-07-13)
 * Manages physical return lifecycle: EXPECTED -> IN_TRANSIT -> RECEIVED -> INSPECTED -> RESTOCKED.
 * Golden Rule: Couriers never touch inventory directly; only authoritative InventoryService restocks.
 */

const { generateUUIDv7 } = require('../db/utils');
const { SHIPMENT_RETURN_STATUSES } = require('./constants');
const { receiveStock } = require('../inventory/ledger');

class ShipmentReturnService {
  /**
   * Registers an expected return
   */
  static async createReturn(tx, { shipmentId, reason = 'CUSTOMER_REFUSED', notes = '' }) {
    const tenantId = tx.session.tenantId;
    const shipment = await tx.findById('shipments', shipmentId);
    if (!shipment || shipment.tenant_id !== tenantId) {
      throw new Error(`Shipment ${shipmentId} not found or access denied`);
    }

    const returnId = generateUUIDv7();
    const returnRecord = {
      id: returnId,
      tenant_id: tenantId,
      shipment_id: shipmentId,
      order_id: shipment.order_id,
      status: SHIPMENT_RETURN_STATUSES.EXPECTED,
      reason,
      notes,
      is_inspected: false,
      is_restocked: false,
      created_at: new Date().toISOString()
    };

    return await tx.insert('shipment_returns', returnRecord);
  }

  /**
   * Mark return as received at warehouse/boutique (INV-07-12)
   * NOTE: Receiving parcel does NOT restock inventory!
   */
  static async receiveReturn(tx, { returnId, receivedLocationId = null, notes = '' }) {
    const tenantId = tx.session.tenantId;
    const ret = await tx.findById('shipment_returns', returnId);
    if (!ret || ret.tenant_id !== tenantId) {
      throw new Error(`Return ${returnId} not found or access denied`);
    }

    return await tx.update('shipment_returns', returnId, {
      status: SHIPMENT_RETURN_STATUSES.RECEIVED,
      received_location_id: receivedLocationId,
      received_at: new Date().toISOString(),
      notes: notes || ret.notes
    });
  }

  /**
   * Inspect returned items for damage or wear
   */
  static async inspectReturn(tx, { returnId, isRestockable, inspectedBy = 'stock_manager', condition = 'GOOD', notes = '' }) {
    const tenantId = tx.session.tenantId;
    const ret = await tx.findById('shipment_returns', returnId);
    if (!ret || ret.tenant_id !== tenantId) {
      throw new Error(`Return ${returnId} not found or access denied`);
    }

    if (ret.status !== SHIPMENT_RETURN_STATUSES.RECEIVED) {
      throw new Error(`Return must be RECEIVED before inspection. Current status: ${ret.status}`);
    }

    const nextStatus = isRestockable ? SHIPMENT_RETURN_STATUSES.INSPECTED : SHIPMENT_RETURN_STATUSES.DAMAGED;

    return await tx.update('shipment_returns', returnId, {
      status: nextStatus,
      is_inspected: true,
      is_restockable: Boolean(isRestockable),
      condition,
      inspected_by: inspectedBy,
      inspected_at: new Date().toISOString(),
      inspection_notes: notes
    });
  }

  /**
   * Authoritatively restock returned items into inventory (INV-07-13)
   * Only InventoryService may perform this mutation.
   */
  static async restockReturn(tx, { returnId, locationId, actorId = 'stock_manager' }) {
    const tenantId = tx.session.tenantId;
    const ret = await tx.findById('shipment_returns', returnId);
    if (!ret || ret.tenant_id !== tenantId) {
      throw new Error(`Return ${returnId} not found or access denied`);
    }

    if (!ret.is_inspected || !ret.is_restockable) {
      throw new Error(`Cannot restock return ${returnId}: Item has not passed inspection or is damaged`);
    }

    if (ret.is_restocked) {
      throw new Error(`Return ${returnId} has already been restocked`);
    }

    // Retrieve order items to restock
    const items = await tx.query('order_items', i => i.order_id === ret.order_id);
    if (items.length === 0) {
      throw new Error(`No order items found to restock for order ${ret.order_id}`);
    }

    const restockedItems = [];
    for (const item of items) {
      const quantity = item.qty !== undefined && item.qty !== null ? item.qty : (item.quantity || 1);
      const result = await receiveStock(tx, {
        variantId: item.variant_id,
        locationId: locationId || ret.received_location_id,
        quantity,
        unitCostCentimes: item.unit_price_centimes || 0n,
        referenceType: 'RETURN_RESTOCK',
        referenceId: returnId,
        actorId,
        metadata: { returnId, orderId: ret.order_id }
      });
      restockedItems.push(result);
    }

    await tx.update('shipment_returns', returnId, {
      status: SHIPMENT_RETURN_STATUSES.RESTOCKED,
      is_restocked: true,
      restocked_at: new Date().toISOString()
    });

    return {
      returnId,
      status: SHIPMENT_RETURN_STATUSES.RESTOCKED,
      restockedCount: restockedItems.length
    };
  }
}

module.exports = {
  ShipmentReturnService
};
