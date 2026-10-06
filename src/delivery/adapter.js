/**
 * BoutiqFlow DZ — Base Delivery Adapter Contract (INV-07-20)
 * Standard interface for all Algerian parcel couriers.
 */

const { SHIPMENT_STATUSES } = require('./constants');
const { DeliveryError } = require('./errors');

class BaseDeliveryAdapter {
  constructor(accountConfig = {}) {
    this.accountId = accountConfig.id || null;
    this.provider = accountConfig.provider || 'UNKNOWN';
    this.apiKey = accountConfig.apiKey || null;
    this.apiToken = accountConfig.apiToken || null;
    this.baseUrl = accountConfig.baseUrl || '';
    this.webhookSecret = accountConfig.webhookSecret || null;
    this.recipientRole = accountConfig.recipientRole || 'PROCESSOR'; // Algerian Law 25-11 classification
    this.isCrossBorder = Boolean(accountConfig.isCrossBorder);
  }

  async createShipment(shipmentPayload) {
    throw new Error('createShipment() must be implemented by delivery adapter');
  }

  async cancelShipment(providerShipmentId, reason = null) {
    throw new Error('cancelShipment() must be implemented by delivery adapter');
  }

  async getShipment(providerShipmentId) {
    throw new Error('getShipment() must be implemented by delivery adapter');
  }

  async trackShipment(trackingNumber) {
    throw new Error('trackShipment() must be implemented by delivery adapter');
  }

  async getRates(query) {
    throw new Error('getRates() must be implemented by delivery adapter');
  }

  async getPickupLocations(wilayaCode) {
    return [];
  }

  verifyWebhookSignature(req) {
    return true;
  }

  normalizeStatus(rawStatus) {
    if (!rawStatus) return SHIPMENT_STATUSES.SUBMITTED;
    const str = String(rawStatus).toUpperCase().trim();
    if (Object.values(SHIPMENT_STATUSES).includes(str)) {
      return str;
    }

    const s = String(rawStatus)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();

    if (s.includes('livr') || s === 'delivered') return SHIPMENT_STATUSES.DELIVERED;
    if (s.includes('sorti') || s.includes('cours') || s.includes('out_for_delivery')) return SHIPMENT_STATUSES.OUT_FOR_DELIVERY;
    if (s.includes('dest') || s.includes('centre de dist') || s.includes('wilaya')) return SHIPMENT_STATUSES.AT_DESTINATION;
    if (s.includes('transit')) return SHIPMENT_STATUSES.IN_TRANSIT;
    if (s.includes('ramass') || s.includes('collect') || s === 'picked_up') return SHIPMENT_STATUSES.PICKED_UP;
    if (s.includes('prepar') || s.includes('recu') || s.includes('enregistr') || s === 'accepted') return SHIPMENT_STATUSES.ACCEPTED;
    if (s.includes('refus')) return SHIPMENT_STATUSES.REFUSED;
    if (s.includes('echec') || s.includes('tentative') || s.includes('fail')) return SHIPMENT_STATUSES.FAILED_DELIVERY;
    if (s.includes('retour') || s === 'returned') return SHIPMENT_STATUSES.RETURNED;
    if (s.includes('annul') || s === 'cancelled') return SHIPMENT_STATUSES.CANCELLED;
    if (s.includes('perdu') || s === 'lost') return SHIPMENT_STATUSES.LOST;

    return SHIPMENT_STATUSES.IN_TRANSIT;
  }
}

module.exports = {
  BaseDeliveryAdapter
};
