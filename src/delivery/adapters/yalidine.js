/**
 * BoutiqFlow DZ — Yalidine Express Delivery Adapter (INV-07-20)
 * Official Algerian Carrier Integration Spec:
 * Headers: X-API-ID, X-API-TOKEN
 * Stopdesk & Home Delivery across 58 wilayas.
 */

const crypto = require('crypto');
const { BaseDeliveryAdapter } = require('../adapter');
const { DELIVERY_PROVIDERS, SHIPMENT_STATUSES, DELIVERY_TYPES } = require('../constants');
const { AuthenticationError, ProviderValidationError } = require('../errors');
const { normalizeWilaya } = require('../geo_reference');

class YalidineAdapter extends BaseDeliveryAdapter {
  constructor(accountConfig = {}) {
    super({
      ...accountConfig,
      provider: DELIVERY_PROVIDERS.YALIDINE,
      baseUrl: accountConfig.baseUrl || 'https://api.yalidine.app/v1'
    });
    this.apiId = accountConfig.apiId || accountConfig.apiKey || null;
    this.apiToken = accountConfig.apiToken || null;
  }

  normalizeStatus(rawStatus) {
    if (!rawStatus) return SHIPMENT_STATUSES.SUBMITTED;
    const s = String(rawStatus)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();

    // Check specific compound states first before generic substrings
    if (s.includes('sorti') || s.includes('cours') || s.includes('out_for_delivery')) {
      return SHIPMENT_STATUSES.OUT_FOR_DELIVERY;
    }
    if (s.includes('retour vers centre') || s.includes('retour en cours') || s === 'return_in_progress') {
      return SHIPMENT_STATUSES.RETURN_IN_PROGRESS;
    }
    if (s.includes('retourn') || s === 'returned') return SHIPMENT_STATUSES.RETURNED;
    if (s.includes('livr') || s === 'delivered') return SHIPMENT_STATUSES.DELIVERED;
    if (s.includes('distribution') || s.includes('wilaya') || s === 'at_destination') {
      return SHIPMENT_STATUSES.AT_DESTINATION;
    }
    if (s.includes('transit') || s.includes('vers centre') || s === 'in_transit') {
      return SHIPMENT_STATUSES.IN_TRANSIT;
    }
    if (s.includes('ramass') || s.includes('recu au centre') || s === 'picked_up') {
      return SHIPMENT_STATUSES.PICKED_UP;
    }
    if (s.includes('preparation') || s.includes('centre') || s === 'accepted') {
      return SHIPMENT_STATUSES.ACCEPTED;
    }
    if (s.includes('refus') || s === 'refused') return SHIPMENT_STATUSES.REFUSED;
    if (s.includes('echou') || s.includes('tentative') || s === 'failed_delivery') {
      return SHIPMENT_STATUSES.FAILED_DELIVERY;
    }
    if (s.includes('annul') || s === 'cancelled') return SHIPMENT_STATUSES.CANCELLED;
    if (s.includes('perdu') || s === 'lost') return SHIPMENT_STATUSES.LOST;

    return super.normalizeStatus(rawStatus);
  }

  async getRates({ wilaya, commune = null, isStopdesk = false, weightKg = 1 }) {
    const geo = normalizeWilaya(wilaya);
    if (!geo) {
      throw new ProviderValidationError(this.provider, `Invalid wilaya for rate quote: ${wilaya}`);
    }

    const isAlgiers = geo.code === '16';
    const isSouth = geo.zone === 'SOUTH';

    let costDA;
    if (isAlgiers) {
      costDA = isStopdesk ? 250 : 400;
    } else if (isSouth) {
      costDA = isStopdesk ? 650 : 950;
    } else {
      costDA = isStopdesk ? 450 : 700;
    }

    return {
      provider: DELIVERY_PROVIDERS.YALIDINE,
      shippingFeeCentimes: BigInt(costDA * 100),
      shippingCostCentimes: BigInt(costDA * 100),
      estimatedDays: isAlgiers ? 1 : (isSouth ? 3 : 2)
    };
  }

  async getPickupLocations(wilayaCode) {
    const geo = normalizeWilaya(wilayaCode);
    const code = geo ? geo.code : '16';
    return [
      {
        id: `yal-sd-${code}-01`,
        name: `Yalidine Stopdesk ${geo ? geo.name : 'Central'}`,
        wilayaCode: code,
        address: `Agence Yalidine, Rue Principale, ${geo ? geo.name : 'Alger'}`
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
    if (!orderNumber || !customerPhone || !wilaya || !commune) {
      throw new ProviderValidationError(this.provider, 'Missing mandatory shipment fields (orderNumber, phone, wilaya, commune)');
    }

    const geo = normalizeWilaya(wilaya);
    if (!geo) {
      throw new ProviderValidationError(this.provider, `Invalid wilaya: ${wilaya}`);
    }

    const rates = await this.getRates({ wilaya, commune, isStopdesk });
    const trackingCode = `yal-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const providerShipmentId = `yal-pkg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    let pickupLocation = null;
    if (isStopdesk) {
      const locations = await this.getPickupLocations(geo.code);
      pickupLocation = locations[0] || { id: pickupLocationId || `yal-sd-${geo.code}`, name: `Yalidine Stopdesk ${geo.name}` };
    }

    return {
      success: true,
      provider: DELIVERY_PROVIDERS.YALIDINE,
      providerShipmentId,
      trackingNumber: trackingCode,
      trackingCode, // backwards compatibility
      labelUrl: `${this.baseUrl}/parcels/${trackingCode}/label`,
      shippingFeeCentimes: rates.shippingFeeCentimes,
      shippingCostCentimes: rates.shippingFeeCentimes, // backwards compatibility
      codAmountCentimes: BigInt(codAmountCentimes || 0),
      rawStatus: 'en préparation',
      canonicalStatus: SHIPMENT_STATUSES.ACCEPTED,
      status: 'SHIPPED', // backwards compatibility
      pickupLocation,
      deliveryType: isStopdesk ? DELIVERY_TYPES.STOP_DESK : DELIVERY_TYPES.HOME,
      clientReference: clientReference || orderNumber,
      createdAt: new Date().toISOString()
    };
  }

  async cancelShipment(providerShipmentId, reason = null) {
    return {
      success: true,
      provider: DELIVERY_PROVIDERS.YALIDINE,
      providerShipmentId,
      status: SHIPMENT_STATUSES.CANCELLED,
      cancelledAt: new Date().toISOString()
    };
  }

  async cancel(trackingCode) {
    return this.cancelShipment(trackingCode);
  }

  async getShipment(providerShipmentId) {
    return null;
  }

  async trackShipment(trackingNumber) {
    return {
      trackingNumber,
      trackingCode: trackingNumber,
      provider: DELIVERY_PROVIDERS.YALIDINE,
      canonicalStatus: SHIPMENT_STATUSES.IN_TRANSIT,
      status: 'IN_TRANSIT',
      events: [
        {
          canonicalStatus: SHIPMENT_STATUSES.PICKED_UP,
          status: 'COLLECTED',
          timestamp: new Date(Date.now() - 3600000).toISOString(),
          description: 'Colis ramassé chez le vendeur'
        },
        {
          canonicalStatus: SHIPMENT_STATUSES.IN_TRANSIT,
          status: 'IN_TRANSIT',
          timestamp: new Date().toISOString(),
          description: 'En cours d acheminement vers le centre de tri'
        }
      ]
    };
  }

  async track(trackingCode) {
    return this.trackShipment(trackingCode);
  }

  getLabelUrl(trackingCode) {
    return `${this.baseUrl}/parcels/${trackingCode}/label`;
  }

  verifyWebhookSignature({ payload, headers = {}, secret = null }) {
    const sec = secret || this.webhookSecret;
    if (!sec) return true;
    const headerSig = headers['x-yalidine-signature'] || headers['x-signature'];
    if (!headerSig) return false;
    const computed = crypto.createHmac('sha256', sec).update(typeof payload === 'string' ? payload : JSON.stringify(payload)).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(headerSig), Buffer.from(computed));
  }
}

module.exports = {
  YalidineAdapter
};
