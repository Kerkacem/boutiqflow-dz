/**
 * BoutiqFlow DZ — Core Shipment Service (Phase 07)
 * Orchestrates local shipment creation, provider dispatch, idempotency,
 * timeout recovery (INV-07-08), immutable snapshots, and privacy journal logging (INV-07-15).
 */

const { generateUUIDv7 } = require('../db/utils');
const {
  DELIVERY_PROVIDERS,
  SHIPMENT_STATUSES,
  DELIVERY_TYPES,
  VALID_SHIPMENT_TRANSITIONS
} = require('./constants');
const {
  DeliveryError,
  ProviderValidationError,
  ProviderTimeoutError,
  DuplicateShipmentError
} = require('./errors');
const { executeWithRetry } = require('./retry');
const { normalizeWilaya } = require('./geo_reference');
const { YalidineAdapter } = require('./adapters/yalidine');
const { ZrExpressAdapter } = require('./adapters/zr_express');
const { NoestAdapter } = require('./adapters/noest');
const { MaystroAdapter } = require('./adapters/maystro');
const { GenericDeliveryProvider } = require('./adapters/generic');
const { FakeDeliveryProvider } = require('./adapters/sandbox');

class ShipmentService {
  /**
   * Resolves appropriate provider adapter instance
   */
  static getAdapter(providerName, accountConfig = {}) {
    const prov = (providerName || '').toUpperCase();
    switch (prov) {
      case DELIVERY_PROVIDERS.YALIDINE:
        return new YalidineAdapter(accountConfig);
      case DELIVERY_PROVIDERS.ZR_EXPRESS:
        return new ZrExpressAdapter(accountConfig);
      case DELIVERY_PROVIDERS.NOEST:
        return new NoestAdapter(accountConfig);
      case DELIVERY_PROVIDERS.MAYSTRO:
        return new MaystroAdapter(accountConfig);
      case DELIVERY_PROVIDERS.SANDBOX:
        return new FakeDeliveryProvider(accountConfig);
      case DELIVERY_PROVIDERS.GENERIC:
      default:
        return new GenericDeliveryProvider({ ...accountConfig, provider: prov || DELIVERY_PROVIDERS.GENERIC });
    }
  }

  /**
   * Authoritatively creates and dispatches a parcel shipment (INV-07-01, INV-07-04, INV-07-08)
   */
  static async createShipment(tx, {
    orderId,
    provider = DELIVERY_PROVIDERS.YALIDINE,
    isStopdesk = false,
    pickupLocation = null,
    customShippingFeeCentimes = null,
    operationId = null,
    actorId = 'system',
    adapterOverride = null,
    originSnapshot = null
  }) {
    const tenantId = tx.session.tenantId;
    const adapter = adapterOverride || this.getAdapter(provider);

    // 1. Idempotency Check via operationId (INV-07-04)
    if (operationId) {
      const existingByOp = await tx.query('shipments', s => s.operation_id === operationId && s.tenant_id === tenantId);
      if (existingByOp.length > 0) {
        const existing = existingByOp[0];
        if (existing.status !== SHIPMENT_STATUSES.DRAFT && existing.status !== SHIPMENT_STATUSES.EXCEPTION) {
          return {
            ...existing,
            isDuplicate: true,
            replayed: true
          };
        }
      }
    }

    // 2. Check active shipments for orderId
    const existingForOrder = await tx.query('shipments', s =>
      s.order_id === orderId &&
      s.tenant_id === tenantId &&
      s.status !== SHIPMENT_STATUSES.CANCELLED
    );

    let shipmentRecord = null;
    if (existingForOrder.length > 0) {
      const active = existingForOrder[0];
      if (active.status !== SHIPMENT_STATUSES.DRAFT && active.status !== SHIPMENT_STATUSES.EXCEPTION) {
        return {
          ...active,
          isDuplicate: true,
          replayed: true
        };
      }
      shipmentRecord = active;
    }

    // 3. Fetch and Validate Order
    const order = await tx.findById('online_orders', orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }
    if (order.tenant_id !== tenantId) {
      throw new Error('Security Violation: Order belongs to another tenant (INV-07-01, INV-07-14)');
    }

    const allowableOrderStatuses = ['CONFIRMED', 'RESERVED', 'PREPARING', 'READY_TO_SHIP'];
    if (!allowableOrderStatuses.includes(order.status)) {
      throw new Error(`Order ${orderId} cannot be shipped from status '${order.status}'. Must be CONFIRMED or READY_TO_SHIP.`);
    }

    // 4. Validate and Normalize Recipient Geo Reference
    const geo = normalizeWilaya(order.wilaya);
    if (!geo) {
      throw new ProviderValidationError(provider, `Invalid Algerian wilaya for recipient: ${order.wilaya}`);
    }

    // 5. Build Snapshots
    const recipientSnapshot = {
      fullName: order.customer_name || 'Client',
      phone: order.customer_phone,
      wilaya: geo.name,
      wilayaCode: geo.code,
      commune: order.commune || 'Centre',
      address: order.address || 'Livraison à domicile',
      deliveryType: isStopdesk ? DELIVERY_TYPES.STOP_DESK : DELIVERY_TYPES.HOME,
      pickupLocation: pickupLocation || null
    };

    const origin = originSnapshot || {
      name: 'Boutique Centrale',
      address: 'Centre Commercial, Alger',
      phone: '+213550000000',
      wilaya: 'Alger',
      wilayaCode: '16'
    };

    const shippingFeeAtCreation = customShippingFeeCentimes !== null && customShippingFeeCentimes !== undefined
      ? BigInt(customShippingFeeCentimes)
      : (order.delivery_fee_centimes !== undefined && order.delivery_fee_centimes !== null
          ? BigInt(order.delivery_fee_centimes)
          : 50000n);

    const codAmount = order.cod_amount_centimes !== undefined && order.cod_amount_centimes !== null
      ? BigInt(order.cod_amount_centimes)
      : BigInt(order.total_centimes || 0);

    const clientReference = `order-${order.order_number || orderId}`;

    // 6. Create or reuse Local Shipment in DRAFT Status
    let shipmentId;
    if (shipmentRecord) {
      shipmentId = shipmentRecord.id;
    } else {
      shipmentId = generateUUIDv7();
      const draftRecord = {
        id: shipmentId,
        tenant_id: tenantId,
        order_id: orderId,
        provider: provider.toUpperCase(),
        delivery_type: isStopdesk ? DELIVERY_TYPES.STOP_DESK : DELIVERY_TYPES.HOME,
        status: SHIPMENT_STATUSES.DRAFT,
        cod_amount_centimes: codAmount,
        shipping_fee_at_creation_centimes: shippingFeeAtCreation, // IMMUTABLE (INV-07-11)
        shipping_cost_centimes: shippingFeeAtCreation, // Backwards compatibility
        currency: 'DZD',
        recipient_snapshot: recipientSnapshot,
        origin_snapshot: origin,
        client_reference: clientReference,
        operation_id: operationId,
        tracking_number: null,
        tracking_code: null, // Backwards compatibility
        provider_shipment_id: null,
        label_url: null,
        courier_account_id: adapter.accountId || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      await tx.insert('shipments', draftRecord);
    }

    // 7. Check if carrier already has this parcel on RETRY (Timeout Recovery INV-07-08)
    let providerResult = null;
    if (shipmentRecord && (shipmentRecord.status === SHIPMENT_STATUSES.DRAFT || shipmentRecord.status === SHIPMENT_STATUSES.EXCEPTION)) {
      try {
        if (typeof adapter.getShipment === 'function') {
          const existingRemote = await adapter.getShipment(clientReference);
          if (existingRemote && (existingRemote.trackingNumber || existingRemote.trackingCode)) {
            providerResult = {
              ...existingRemote,
              isDuplicate: true,
              replayed: true
            };
          }
        }
      } catch (checkErr) {}
    }

    // 8. If not found on carrier, dispatch remote creation with Bounded Retry (INV-07-17)
    if (!providerResult) {
      try {
        providerResult = await executeWithRetry(
          async (attempt) => {
            return await adapter.createShipment({
              orderNumber: order.order_number || orderId,
              customerName: recipientSnapshot.fullName,
              customerPhone: recipientSnapshot.phone,
              address: recipientSnapshot.address,
              wilaya: recipientSnapshot.wilaya,
              commune: recipientSnapshot.commune,
              codAmountCentimes: codAmount,
              isStopdesk,
              pickupLocationId: pickupLocation ? pickupLocation.id : null,
              clientReference
            });
          },
          {
            maxRetries: 3,
            baseDelayMs: 50
          }
        );
      } catch (err) {
        await tx.update('shipments', shipmentId, {
          status: SHIPMENT_STATUSES.EXCEPTION,
          error_message: err.message
        });
        throw err;
      }
    }

    // 9. Update Local Shipment with Authoritative Provider Result
    const canonicalStatus = providerResult.canonicalStatus || SHIPMENT_STATUSES.ACCEPTED;
    const trackingNumber = providerResult.trackingNumber || providerResult.trackingCode;
    const providerShipmentId = providerResult.providerShipmentId || trackingNumber;

    const resolvedRecipientSnapshot = {
      ...recipientSnapshot,
      pickupLocation: recipientSnapshot.pickupLocation || providerResult.pickupLocation || null
    };

    const updatedShipment = await tx.update('shipments', shipmentId, {
      status: canonicalStatus,
      tracking_number: trackingNumber,
      tracking_code: trackingNumber, // backwards compatibility
      provider_shipment_id: providerShipmentId,
      label_url: providerResult.labelUrl || null,
      courier_account_id: adapter.accountId || null,
      recipient_snapshot: resolvedRecipientSnapshot,
      error_message: null
    });

    // 10. Update Commercial Order Status
    await tx.update('online_orders', orderId, {
      status: 'READY_TO_SHIP',
      tracking_code: trackingNumber,
      courier_account_id: adapter.accountId || null
    });

    // 11. Automated Privacy Compliance Journal Log (Law 25-11 / 18-07, INV-07-15)
    await tx.insert('processing_journal', {
      action: 'PERSONAL_DATA_TRANSMITTED',
      details: `Customer personal delivery data transmitted to carrier ${provider}`,
      data_categories: ['recipient_name', 'recipient_phone', 'recipient_address'],
      purpose: 'DELIVERY_FULFILLMENT',
      destination: adapter.baseUrl || provider,
      provider: provider,
      shipment_id: shipmentId,
      order_id: orderId,
      actor_id: actorId,
      actor_role: 'system',
      created_at: new Date().toISOString()
    });

    // 12. Cross-Border Transfer Record if applicable (INV-07-15)
    if (adapter.isCrossBorder) {
      await tx.insert('transfer_records', {
        shipment_id: shipmentId,
        destination: adapter.baseUrl || 'CROSS_BORDER',
        recipient: provider,
        purpose: 'INTERNATIONAL_DELIVERY_DISPATCH',
        legal_basis: 'Article 43 Law 18-07 / 25-11',
        status: 'COMPLETED',
        created_at: new Date().toISOString()
      });
    }

    return {
      ...updatedShipment,
      isDuplicate: Boolean(providerResult.isDuplicate || providerResult.replayed || shipmentRecord),
      replayed: Boolean(providerResult.replayed || shipmentRecord)
    };
  }

  /**
   * Cancel an existing shipment (INV-07-03)
   */
  static async cancelShipment(tx, { shipmentId, reason = null, actorId = 'system' }) {
    const tenantId = tx.session.tenantId;
    const shipment = await tx.findById('shipments', shipmentId);
    if (!shipment || shipment.tenant_id !== tenantId) {
      throw new Error(`Shipment ${shipmentId} not found or access denied (INV-07-14)`);
    }

    if (shipment.status === SHIPMENT_STATUSES.CANCELLED) {
      return shipment;
    }

    if (shipment.status === SHIPMENT_STATUSES.DELIVERED || shipment.status === SHIPMENT_STATUSES.RETURNED) {
      throw new Error(`Shipment in status '${shipment.status}' cannot be cancelled`);
    }

    const adapter = this.getAdapter(shipment.provider);
    if (shipment.provider_shipment_id && typeof adapter.cancelShipment === 'function') {
      try {
        await adapter.cancelShipment(shipment.provider_shipment_id, reason);
      } catch (err) {}
    }

    return await tx.update('shipments', shipmentId, {
      status: SHIPMENT_STATUSES.CANCELLED,
      cancel_reason: reason
    });
  }

  /**
   * Track shipment events
   */
  static async trackShipment(tx, { shipmentId }) {
    const tenantId = tx.session.tenantId;
    const shipment = await tx.findById('shipments', shipmentId);
    if (!shipment || shipment.tenant_id !== tenantId) {
      throw new Error(`Shipment ${shipmentId} not found or access denied (INV-07-14)`);
    }

    const adapter = this.getAdapter(shipment.provider);
    return await adapter.trackShipment(shipment.tracking_number || shipment.tracking_code);
  }
}

module.exports = {
  ShipmentService
};
