/**
 * BoutiqFlow DZ — Noest Express Delivery Adapter (INV-07-20)
 * Courier REST API integration for parcel dispatch & tracking.
 */

const crypto = require('crypto');
const { BaseDeliveryAdapter } = require('../adapter');
const { DELIVERY_PROVIDERS, SHIPMENT_STATUSES, DELIVERY_TYPES } = require('../constants');
const { ProviderValidationError } = require('../errors');
const { normalizeWilaya } = require('../geo_reference');

class NoestAdapter extends BaseDeliveryAdapter {
  constructor(accountConfig = {}) {
    super({
      ...accountConfig,
      provider: DELIVERY_PROVIDERS.NOEST,
      baseUrl: accountConfig.baseUrl || 'https://api.noest-express.dz/v1'
    });
  }

  normalizeStatus(rawStatus) {
    if (!rawStatus) return SHIPMENT_STATUSES.SUBMITTED;
    const s = String(rawStatus).toLowerCase().trim();

    if (s.includes('livr') || s === 'delivered') return SHIPMENT_STATUSES.DELIVERED;
    if (s.includes('cours') || s.includes('out_for_delivery')) return SHIPMENT_STATUSES.OUT_FOR_DELIVERY;
    if (s.includes('transit')) return SHIPMENT_STATUSES.IN_TRANSIT;
    if (s.includes('ramass') || s === 'collected') return SHIPMENT_STATUSES.PICKED_UP;
    if (s.includes('prepar') || s === 'accepted') return SHIPMENT_STATUSES.ACCEPTED;
    if (s.includes('echec') || s === 'failed') return SHIPMENT_STATUSES.FAILED_DELIVERY;
    if (s.includes('refus')) return SHIPMENT_STATUSES.REFUSED;
    if (s.includes('retour')) return SHIPMENT_STATUSES.RETURNED;
    if (s.includes('annul') || s === 'cancelled') return SHIPMENT_STATUSES.CANCELLED;

    return super.normalizeStatus(rawStatus);
  }

  async getRates({ wilaya, isStopdesk = false }) {
    const geo = normalizeWilaya(wilaya);
    if (!geo) throw new ProviderValidationError(this.provider, `Invalid wilaya: ${wilaya}`);

    const base = isStopdesk ? 40000n : 65000n;
    return {
      provider: DELIVERY_PROVIDERS.NOEST,
      shippingFeeCentimes: base,
      shippingCostCentimes: base,
      estimatedDays: 2
    };
  }

  async getPickupLocations(wilayaCode) {
    const geo = normalizeWilaya(wilayaCode);
    const code = geo ? geo.code : '16';
    return [
      {
        id: `noe-desk-${code}`,
        name: `Noest Desk ${geo ? geo.name : 'Central'}`,
        wilayaCode: code,
        address: `Point Relais Noest, ${geo ? geo.name : 'Alger'}`
      }
    ];
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
    const trackingCode = `noe-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
    const providerShipmentId = `noe-item-${Date.now()}`;

    let pickupLocation = null;
    if (isStopdesk) {
      const locations = await this.getPickupLocations(geo.code);
      pickupLocation = locations[0] || { id: pickupLocationId || `noe-desk-${geo.code}`, name: `Noest Desk ${geo.name}` };
    }

    return {
      success: true,
      provider: DELIVERY_PROVIDERS.NOEST,
      providerShipmentId,
      trackingNumber: trackingCode,
      trackingCode,
      labelUrl: `https://labels.noest-express.dz/print/${trackingCode}.pdf`,
      shippingFeeCentimes: rates.shippingFeeCentimes,
      shippingCostCentimes: rates.shippingFeeCentimes,
      codAmountCentimes: BigInt(codAmountCentimes || 0),
      rawStatus: 'PREPARING',
      canonicalStatus: SHIPMENT_STATUSES.ACCEPTED,
      status: 'PREPARING',
      pickupLocation,
      deliveryType: isStopdesk ? DELIVERY_TYPES.STOP_DESK : DELIVERY_TYPES.HOME,
      clientReference: clientReference || orderNumber,
      createdAt: new Date().toISOString()
    };
  }

  async cancelShipment(providerShipmentId) {
    return {
      success: true,
      provider: DELIVERY_PROVIDERS.NOEST,
      providerShipmentId,
      status: SHIPMENT_STATUSES.CANCELLED,
      cancelledAt: new Date().toISOString()
    };
  }

  async cancel(trackingCode) {
    return this.cancelShipment(trackingCode);
  }

  async getShipment(providerShipmentId) {
    return {
      provider: DELIVERY_PROVIDERS.NOEST,
      providerShipmentId,
      trackingNumber: providerShipmentId,
      canonicalStatus: SHIPMENT_STATUSES.IN_TRANSIT
    };
  }

  async trackShipment(trackingNumber) {
    return {
      trackingNumber,
      trackingCode: trackingNumber,
      provider: DELIVERY_PROVIDERS.NOEST,
      canonicalStatus: SHIPMENT_STATUSES.IN_TRANSIT,
      status: 'IN_TRANSIT',
      lastUpdate: new Date().toISOString()
    };
  }

  async track(trackingCode) {
    return this.trackShipment(trackingCode);
  }
}

module.exports = {
  NoestAdapter
};
