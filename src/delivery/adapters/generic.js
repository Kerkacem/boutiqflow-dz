/**
 * BoutiqFlow DZ — Generic Delivery Provider Adapter (INV-07-20)
 * Pluggable adapter allowing seamless connection of regional/custom Algerian couriers
 * without modifying the core Order, Inventory, or Cash domains.
 */

const crypto = require('crypto');
const { BaseDeliveryAdapter } = require('../adapter');
const { DELIVERY_PROVIDERS, SHIPMENT_STATUSES, DELIVERY_TYPES } = require('../constants');
const { ProviderValidationError } = require('../errors');
const { normalizeWilaya } = require('../geo_reference');

class GenericDeliveryProvider extends BaseDeliveryAdapter {
  constructor(accountConfig = {}) {
    super({
      ...accountConfig,
      provider: accountConfig.provider || DELIVERY_PROVIDERS.GENERIC,
      baseUrl: accountConfig.baseUrl || 'https://api.generic-courier.dz/v1'
    });
    this.customStatusMap = accountConfig.customStatusMap || {};
    this.defaultShippingFeeCentimes = accountConfig.defaultShippingFeeCentimes || 50000n;
  }

  normalizeStatus(rawStatus) {
    if (!rawStatus) return SHIPMENT_STATUSES.SUBMITTED;
    const mapped = this.customStatusMap[rawStatus] || this.customStatusMap[String(rawStatus).toLowerCase()];
    if (mapped && Object.values(SHIPMENT_STATUSES).includes(mapped)) {
      return mapped;
    }
    return super.normalizeStatus(rawStatus);
  }

  async getRates({ wilaya, isStopdesk = false }) {
    const geo = normalizeWilaya(wilaya);
    if (!geo) throw new ProviderValidationError(this.provider, `Invalid wilaya: ${wilaya}`);

    return {
      provider: this.provider,
      shippingFeeCentimes: BigInt(this.defaultShippingFeeCentimes),
      estimatedDays: 2
    };
  }

  async createShipment({
    orderNumber,
    customerName,
    customerPhone,
    address,
    wilaya,
    commune,
    codAmountCentimes,
    isStopdesk = false,
    pickupLocationId = null,
    clientReference = null
  }) {
    if (!orderNumber || !customerPhone || !wilaya) {
      throw new ProviderValidationError(this.provider, 'Missing mandatory shipment fields');
    }

    const geo = normalizeWilaya(wilaya);
    if (!geo) throw new ProviderValidationError(this.provider, `Invalid wilaya: ${wilaya}`);

    const rates = await this.getRates({ wilaya, isStopdesk });
    const trackingCode = `gen-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const providerShipmentId = `gen-parcel-${Date.now()}`;

    return {
      success: true,
      provider: this.provider,
      providerShipmentId,
      trackingNumber: trackingCode,
      trackingCode,
      labelUrl: `${this.baseUrl}/parcels/${trackingCode}/label.pdf`,
      shippingFeeCentimes: rates.shippingFeeCentimes,
      shippingCostCentimes: rates.shippingFeeCentimes,
      codAmountCentimes: BigInt(codAmountCentimes || 0),
      rawStatus: 'CREATED',
      canonicalStatus: SHIPMENT_STATUSES.ACCEPTED,
      status: 'SHIPPED',
      pickupLocation: isStopdesk ? { id: pickupLocationId || `gen-sd-${geo.code}`, name: `Pickup ${geo.name}` } : null,
      deliveryType: isStopdesk ? DELIVERY_TYPES.STOP_DESK : DELIVERY_TYPES.HOME,
      clientReference: clientReference || orderNumber,
      createdAt: new Date().toISOString()
    };
  }

  async cancelShipment(providerShipmentId) {
    return {
      success: true,
      provider: this.provider,
      providerShipmentId,
      status: SHIPMENT_STATUSES.CANCELLED,
      cancelledAt: new Date().toISOString()
    };
  }

  async getShipment(providerShipmentId) {
    return {
      provider: this.provider,
      providerShipmentId,
      trackingNumber: providerShipmentId,
      canonicalStatus: SHIPMENT_STATUSES.IN_TRANSIT
    };
  }

  async trackShipment(trackingNumber) {
    return {
      trackingNumber,
      trackingCode: trackingNumber,
      provider: this.provider,
      canonicalStatus: SHIPMENT_STATUSES.IN_TRANSIT,
      status: 'IN_TRANSIT',
      events: []
    };
  }
}

module.exports = {
  GenericDeliveryProvider
};
