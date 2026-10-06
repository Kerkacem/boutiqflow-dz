/**
 * BoutiqFlow DZ — Shipment Event Processor (Phase 07)
 * Ingests webhooks and polling events, maintains append-only ProviderEvent ledger,
 * enforces Webhook Idempotency (INV-07-05), Status Regression Protection (INV-07-09),
 * and COD Amount Protection (INV-07-10).
 */

const crypto = require('crypto');
const { generateUUIDv7 } = require('../db/utils');
const {
  SHIPMENT_STATUSES,
  STATUS_PRECEDENCE,
  VALID_SHIPMENT_TRANSITIONS,
  COURIER_COLLECTION_STATUSES,
  SHIPMENT_RETURN_STATUSES
} = require('./constants');
const { ShipmentService } = require('./shipment_service');

class ShipmentEventProcessor {
  /**
   * Hashes payload for duplicate detection
   */
  static hashPayload(payload) {
    const str = typeof payload === 'string'
      ? payload
      : JSON.stringify(payload, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  /**
   * Processes an incoming webhook or polling event idempotently (INV-07-05)
   */
  static async processEvent(tx, {
    provider,
    rawPayload,
    externalEventId = null,
    trackingNumber = null,
    providerShipmentId = null,
    occurredAt = null
  }) {
    const tenantId = tx.session.tenantId;
    const payloadHash = this.hashPayload(rawPayload);

    // 1. Webhook Idempotency Check (INV-07-05)
    let duplicateQuery = null;
    if (externalEventId) {
      duplicateQuery = await tx.query('provider_events', e =>
        e.tenant_id === tenantId &&
        e.provider === provider &&
        e.external_event_id === externalEventId
      );
    } else {
      duplicateQuery = await tx.query('provider_events', e =>
        e.tenant_id === tenantId &&
        e.provider === provider &&
        e.payload_hash === payloadHash
      );
    }

    if (duplicateQuery && duplicateQuery.length > 0) {
      return {
        success: true,
        isDuplicate: true,
        replayed: true,
        providerEventId: duplicateQuery[0].id
      };
    }

    // 2. Identify Target Shipment
    let shipment = null;
    if (trackingNumber) {
      const byTracking = await tx.query('shipments', s =>
        s.tenant_id === tenantId &&
        (s.tracking_number === trackingNumber || s.tracking_code === trackingNumber)
      );
      if (byTracking.length > 0) shipment = byTracking[0];
    }

    if (!shipment && providerShipmentId) {
      const byProviderId = await tx.query('shipments', s =>
        s.tenant_id === tenantId &&
        s.provider_shipment_id === providerShipmentId
      );
      if (byProviderId.length > 0) shipment = byProviderId[0];
    }

    if (!shipment) {
      throw new Error(`Target shipment not found for tracking: ${trackingNumber || providerShipmentId}`);
    }

    // 3. Normalize Status via Provider Adapter
    const adapter = ShipmentService.getAdapter(provider);
    const rawStatus = rawPayload.status || rawPayload.rawStatus || 'UNKNOWN';
    const canonicalStatus = adapter.normalizeStatus(rawStatus);

    // 4. Record in Append-Only ProviderEvent Ledger (INV-07-05)
    const providerEventId = generateUUIDv7();
    const providerEvent = {
      id: providerEventId,
      tenant_id: tenantId,
      provider: provider.toUpperCase(),
      external_event_id: externalEventId,
      provider_shipment_id: providerShipmentId || shipment.provider_shipment_id,
      tracking_number: trackingNumber || shipment.tracking_number,
      shipment_id: shipment.id,
      event_type: 'CARRIER_STATUS_UPDATE',
      raw_status: rawStatus,
      canonical_status: canonicalStatus,
      payload_hash: payloadHash,
      occurred_at: occurredAt || new Date().toISOString(),
      received_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      processing_status: 'PROCESSED'
    };

    await tx.insert('provider_events', providerEvent);

    // 5. Apply Status Update with Regression & Invariant Protection
    const codAmountReported = rawPayload.codAmountCentimes !== undefined
      ? BigInt(rawPayload.codAmountCentimes)
      : null;

    const transitionResult = await this.applyStatusUpdate(tx, {
      shipment,
      canonicalStatus,
      rawStatus,
      occurredAt: providerEvent.occurred_at,
      codAmountReported
    });

    return {
      success: true,
      providerEventId,
      canonicalStatus,
      shipmentStatus: transitionResult.currentStatus,
      isRegressed: transitionResult.isRegressed,
      amountMismatch: transitionResult.amountMismatch
    };
  }

  /**
   * Applies state transition with Status Regression Protection (INV-07-09, CHAOS TEST 2)
   */
  static async applyStatusUpdate(tx, {
    shipment,
    canonicalStatus,
    rawStatus,
    occurredAt,
    codAmountReported = null
  }) {
    const tenantId = tx.session.tenantId;
    const currentStatus = shipment.status;

    // Record granular shipment event
    await tx.insert('shipment_events', {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      shipment_id: shipment.id,
      canonical_status: canonicalStatus,
      raw_status: rawStatus,
      occurred_at: occurredAt,
      created_at: new Date().toISOString()
    });

    // Check Status Precedence Regression (INV-07-09)
    // E.g. If current is DELIVERED, an older IN_TRANSIT event MUST NOT regress the status
    const currentRank = STATUS_PRECEDENCE[currentStatus];
    const incomingRank = STATUS_PRECEDENCE[canonicalStatus];

    let shouldUpdateStatus = true;

    if (currentStatus === SHIPMENT_STATUSES.DELIVERED) {
      if (canonicalStatus !== SHIPMENT_STATUSES.DELIVERED && canonicalStatus !== SHIPMENT_STATUSES.RETURN_IN_PROGRESS) {
        shouldUpdateStatus = false;
      }
    } else if (currentRank !== undefined && incomingRank !== undefined) {
      if (incomingRank < currentRank) {
        // Out-of-order older event arriving later
        shouldUpdateStatus = false;
      }
    }

    // Check Valid State Machine Transitions
    const allowed = VALID_SHIPMENT_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(canonicalStatus) && currentStatus !== canonicalStatus) {
      shouldUpdateStatus = false;
    }

    let amountMismatch = false;

    // Check COD Amount Protection (INV-07-10, CHAOS TEST 3)
    if (codAmountReported !== null && codAmountReported !== undefined) {
      const expected = BigInt(shipment.cod_amount_centimes || 0);
      if (codAmountReported !== expected) {
        amountMismatch = true;
      }
    }

    if (shouldUpdateStatus && currentStatus !== canonicalStatus) {
      await tx.update('shipments', shipment.id, {
        status: canonicalStatus,
        last_event_at: occurredAt
      });

      // Synchronize commercial order status where appropriate
      if (canonicalStatus === SHIPMENT_STATUSES.DELIVERED) {
        await tx.update('online_orders', shipment.order_id, {
          status: 'DELIVERED'
        });

        // Initialize CourierCollection tracking (INV-07-18)
        const expectedCod = BigInt(shipment.cod_amount_centimes || 0);
        const collectedCod = codAmountReported !== null ? codAmountReported : expectedCod;
        const diff = collectedCod - expectedCod;

        await tx.insert('courier_collections', {
          id: generateUUIDv7(),
          tenant_id: tenantId,
          shipment_id: shipment.id,
          order_id: shipment.order_id,
          expected_centimes: expectedCod,
          collected_centimes: collectedCod,
          discrepancy_centimes: diff,
          status: diff === 0n ? COURIER_COLLECTION_STATUSES.MATCHED : COURIER_COLLECTION_STATUSES.UNDER_COLLECTION,
          amount_mismatch: diff !== 0n,
          collected_at: occurredAt,
          created_at: new Date().toISOString()
        });
      } else if (canonicalStatus === SHIPMENT_STATUSES.RETURNED) {
        await tx.update('online_orders', shipment.order_id, {
          status: 'RETURNED'
        });

        // Create return entry in RECEIVED status (INV-07-12)
        // Strict guardrail: ZERO inventory mutation!
        await tx.insert('shipment_returns', {
          id: generateUUIDv7(),
          tenant_id: tenantId,
          shipment_id: shipment.id,
          order_id: shipment.order_id,
          status: SHIPMENT_RETURN_STATUSES.RECEIVED,
          is_inspected: false,
          is_restocked: false,
          received_at: occurredAt,
          created_at: new Date().toISOString()
        });
      }
    }

    return {
      currentStatus: shouldUpdateStatus ? canonicalStatus : currentStatus,
      isRegressed: !shouldUpdateStatus && (currentRank > incomingRank),
      amountMismatch
    };
  }
}

module.exports = {
  ShipmentEventProcessor
};
