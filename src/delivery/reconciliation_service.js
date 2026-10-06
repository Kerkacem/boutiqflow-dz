/**
 * BoutiqFlow DZ — Delivery COD Reconciliation Service (INV-07-18, INV-07-19)
 * Reconciles expected COD vs collected COD vs settled remittance.
 * Strict Rule: Delivered does not imply COD settlement; Cash Register and Sales are decoupled.
 */

const { generateUUIDv7 } = require('../db/utils');
const { COURIER_COLLECTION_STATUSES, COURIER_SETTLEMENT_STATUSES } = require('./constants');

class DeliveryReconciliationService {
  /**
   * Records carrier cash collection report
   */
  static async recordCollection(tx, {
    shipmentId,
    collectedCentimes,
    collectedAt = null
  }) {
    const tenantId = tx.session.tenantId;
    const shipment = await tx.findById('shipments', shipmentId);
    if (!shipment || shipment.tenant_id !== tenantId) {
      throw new Error(`Shipment ${shipmentId} not found or access denied`);
    }

    const expected = BigInt(shipment.cod_amount_centimes || 0);
    const collected = BigInt(collectedCentimes);
    const diff = collected - expected;

    let status = COURIER_COLLECTION_STATUSES.MATCHED;
    if (diff < 0n) status = COURIER_COLLECTION_STATUSES.UNDER_COLLECTION;
    else if (diff > 0n) status = COURIER_COLLECTION_STATUSES.OVER_COLLECTION;

    // Check existing collection record
    const existing = await tx.query('courier_collections', c =>
      c.tenant_id === tenantId && c.shipment_id === shipmentId
    );

    if (existing.length > 0) {
      return await tx.update('courier_collections', existing[0].id, {
        collected_centimes: collected,
        discrepancy_centimes: diff,
        status,
        amount_mismatch: diff !== 0n,
        collected_at: collectedAt || new Date().toISOString()
      });
    }

    return await tx.insert('courier_collections', {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      shipment_id: shipment.id,
      order_id: shipment.order_id,
      expected_centimes: expected,
      collected_centimes: collected,
      discrepancy_centimes: diff,
      status,
      amount_mismatch: diff !== 0n,
      collected_at: collectedAt || new Date().toISOString(),
      created_at: new Date().toISOString()
    });
  }

  /**
   * Reconciles courier settlement / remittance statement (CHAOS TEST 3)
   */
  static async reconcileSettlement(tx, {
    courierAccountId = null,
    provider = 'YALIDINE',
    settlementReference,
    remittedCentimes,
    shipmentIds = [],
    settledAt = null
  }) {
    const tenantId = tx.session.tenantId;

    let totalExpectedCod = 0n;
    let totalShippingFees = 0n;
    const matchedShipments = [];

    for (const sId of shipmentIds) {
      const s = await tx.findById('shipments', sId);
      if (s && s.tenant_id === tenantId) {
        matchedShipments.push(s);
        if (s.status === 'DELIVERED') {
          totalExpectedCod += BigInt(s.cod_amount_centimes || 0);
        }
        totalShippingFees += BigInt(s.shipping_fee_at_creation_centimes || s.shipping_cost_centimes || 0);
      }
    }

    const netExpected = totalExpectedCod - totalShippingFees;
    const remitted = BigInt(remittedCentimes);
    const discrepancy = remitted - (totalShippingFees === 0n ? totalExpectedCod : netExpected);

    let status = COURIER_SETTLEMENT_STATUSES.MATCHED;
    if (discrepancy < 0n) {
      status = COURIER_SETTLEMENT_STATUSES.UNDER_SETTLED;
    } else if (discrepancy > 0n) {
      status = COURIER_SETTLEMENT_STATUSES.OVER_SETTLED;
    }

    const settlementRecord = {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      courier_account_id: courierAccountId,
      provider: provider.toUpperCase(),
      settlement_reference: settlementReference,
      expected_centimes: totalExpectedCod,
      shipping_fees_centimes: totalShippingFees,
      net_expected_centimes: netExpected,
      remitted_centimes: remitted,
      discrepancy_centimes: discrepancy,
      status,
      shipment_count: matchedShipments.length,
      settled_at: settledAt || new Date().toISOString(),
      created_at: new Date().toISOString()
    };

    const settlement = await tx.insert('courier_settlements', settlementRecord);

    // Also populate legacy cod_remittances table for backward compatibility
    await tx.insert('cod_remittances', {
      id: settlementRecord.id,
      courier_account_id: courierAccountId,
      reference: settlementReference,
      expected_centimes: netExpected,
      received_centimes: remitted,
      fees_centimes: totalShippingFees,
      difference_centimes: discrepancy,
      status: status === COURIER_SETTLEMENT_STATUSES.MATCHED ? 'RECONCILED' : 'DISCREPANCY'
    });

    return {
      settlementId: settlement.id,
      reference: settlementReference,
      totalExpectedCod,
      totalShippingFees,
      netExpected,
      remitted,
      discrepancy,
      status
    };
  }
}

module.exports = {
  DeliveryReconciliationService
};
