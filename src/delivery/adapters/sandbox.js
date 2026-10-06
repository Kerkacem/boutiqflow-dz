/**
 * BoutiqFlow DZ — Fake Delivery Provider & Sandbox Adapter (INV-07-04, INV-07-08)
 * High-fidelity in-memory carrier simulator for chaos testing, deterministic retries,
 * network timeout simulation, and webhook emission without external internet access.
 */

const crypto = require('crypto');
const { BaseDeliveryAdapter } = require('../adapter');
const { DELIVERY_PROVIDERS, SHIPMENT_STATUSES, DELIVERY_TYPES } = require('../constants');
const {
  ProviderTimeoutError,
  ProviderUnavailableError,
  RateLimitError,
  AuthenticationError,
  DuplicateShipmentError,
  ProviderValidationError
} = require('../errors');
const { normalizeWilaya } = require('../geo_reference');

class FakeDeliveryProvider extends BaseDeliveryAdapter {
  constructor(accountConfig = {}) {
    super({
      ...accountConfig,
      provider: accountConfig.provider || DELIVERY_PROVIDERS.SANDBOX,
      baseUrl: 'http://mock.delivery.local/v1'
    });

    this.parcels = new Map(); // providerShipmentId -> parcel
    this.trackingMap = new Map(); // trackingNumber -> providerShipmentId
    this.clientRefMap = new Map(); // clientReference -> providerShipmentId

    // Chaos simulation flags
    this.timeoutOnNextCreate = false;
    this.timeoutCountOnCreate = 0;
    this.failCountOnNextCreate = 0;
    this.failType = '500';
    this.rateLimitNextCreate = false;
    this.authFailNextCreate = false;
    this.duplicateOnNextCreate = false;
    this.callCount = 0;
    this.createAttempts = 0;
  }

  resetChaos() {
    this.timeoutOnNextCreate = false;
    this.timeoutCountOnCreate = 0;
    this.failCountOnNextCreate = 0;
    this.failType = '500';
    this.rateLimitNextCreate = false;
    this.authFailNextCreate = false;
    this.duplicateOnNextCreate = false;
    this.callCount = 0;
    this.createAttempts = 0;
  }

  async getRates({ wilaya, isStopdesk = false }) {
    const geo = normalizeWilaya(wilaya);
    if (!geo) throw new ProviderValidationError(this.provider, `Invalid wilaya: ${wilaya}`);

    return {
      provider: this.provider,
      shippingFeeCentimes: isStopdesk ? 30000n : 50000n,
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
    this.callCount++;
    this.createAttempts++;

    // 1. Check idempotency via clientReference
    if (clientReference && this.clientRefMap.has(clientReference)) {
      const existingId = this.clientRefMap.get(clientReference);
      const existing = this.parcels.get(existingId);
      if (existing) {
        if (this.timeoutCountOnCreate > 0) {
          this.timeoutCountOnCreate--;
          throw new ProviderTimeoutError(this.provider, 'Network socket timeout after remote parcel creation');
        }
        return {
          ...existing,
          isDuplicate: true,
          replayed: true
        };
      }
    }

    // 2. Auth error simulation
    if (this.authFailNextCreate) {
      this.authFailNextCreate = false;
      throw new AuthenticationError(this.provider, 'Invalid sandbox API credentials');
    }

    // 3. Rate limit simulation
    if (this.rateLimitNextCreate) {
      this.rateLimitNextCreate = false;
      throw new RateLimitError(this.provider, 'Sandbox 429 rate limit exceeded');
    }

    // 4. Duplicate simulation
    if (this.duplicateOnNextCreate) {
      this.duplicateOnNextCreate = false;
      throw new DuplicateShipmentError(this.provider, `Parcel already registered for clientReference: ${clientReference}`);
    }

    // 5. Fail count simulation (e.g. 500 server error)
    if (this.failCountOnNextCreate > 0) {
      this.failCountOnNextCreate--;
      throw new ProviderUnavailableError(this.provider, 'Sandbox simulated 503 service unavailable');
    }

    // Validate fields
    if (!orderNumber || !customerPhone || !wilaya) {
      throw new ProviderValidationError(this.provider, 'Missing mandatory shipment fields');
    }

    const geo = normalizeWilaya(wilaya);
    if (!geo) throw new ProviderValidationError(this.provider, `Invalid wilaya: ${wilaya}`);

    const trackingNumber = `sbx-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const providerShipmentId = `sbx-parcel-${Date.now()}-${this.createAttempts}`;
    const rates = await this.getRates({ wilaya, isStopdesk });

    const parcel = {
      success: true,
      provider: this.provider,
      providerShipmentId,
      trackingNumber,
      trackingCode: trackingNumber,
      labelUrl: `${this.baseUrl}/parcels/${trackingNumber}/label.pdf`,
      shippingFeeCentimes: rates.shippingFeeCentimes,
      shippingCostCentimes: rates.shippingFeeCentimes,
      codAmountCentimes: BigInt(codAmountCentimes || 0),
      rawStatus: 'SUBMITTED',
      canonicalStatus: SHIPMENT_STATUSES.ACCEPTED,
      status: 'SHIPPED',
      pickupLocation: isStopdesk ? { id: pickupLocationId || `sbx-sd-${geo.code}`, name: `Sandbox Desk ${geo.name}` } : null,
      deliveryType: isStopdesk ? DELIVERY_TYPES.STOP_DESK : DELIVERY_TYPES.HOME,
      clientReference: clientReference || orderNumber,
      createdAt: new Date().toISOString()
    };

    // Save in provider database
    this.parcels.set(providerShipmentId, parcel);
    this.trackingMap.set(trackingNumber, providerShipmentId);
    if (clientReference) {
      this.clientRefMap.set(clientReference, providerShipmentId);
    }

    // 6. Network Timeout AFTER parcel created on remote provider (CHAOS TEST 1)
    if (this.timeoutCountOnCreate > 0) {
      this.timeoutCountOnCreate--;
      throw new ProviderTimeoutError(this.provider, 'Network socket timeout after remote parcel creation');
    }

    if (this.timeoutOnNextCreate) {
      this.timeoutOnNextCreate = false;
      throw new ProviderTimeoutError(this.provider, 'Network socket timeout after remote parcel creation');
    }

    return { ...parcel };
  }

  async cancelShipment(providerShipmentId) {
    const parcel = this.parcels.get(providerShipmentId);
    if (parcel) {
      parcel.canonicalStatus = SHIPMENT_STATUSES.CANCELLED;
      parcel.status = 'CANCELLED';
    }
    return {
      success: true,
      provider: this.provider,
      providerShipmentId,
      status: SHIPMENT_STATUSES.CANCELLED,
      cancelledAt: new Date().toISOString()
    };
  }

  async getShipment(providerShipmentId) {
    let parcel = this.parcels.get(providerShipmentId);
    if (!parcel && this.clientRefMap.has(providerShipmentId)) {
      parcel = this.parcels.get(this.clientRefMap.get(providerShipmentId));
    }
    if (!parcel) return null;
    return { ...parcel };
  }

  async trackShipment(trackingNumber) {
    const id = this.trackingMap.get(trackingNumber);
    const parcel = id ? this.parcels.get(id) : null;
    return {
      trackingNumber,
      provider: this.provider,
      canonicalStatus: parcel ? parcel.canonicalStatus : SHIPMENT_STATUSES.IN_TRANSIT,
      status: 'IN_TRANSIT',
      events: []
    };
  }

  /**
   * Helper to simulate webhook emission from sandbox carrier
   */
  emitWebhook(trackingNumber, { status, rawStatus, codAmountCentimes = null, externalEventId = null }) {
    const id = this.trackingMap.get(trackingNumber);
    const parcel = id ? this.parcels.get(id) : null;
    const evtId = externalEventId || `evt-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    return {
      eventId: evtId,
      provider: this.provider,
      providerShipmentId: id || null,
      trackingNumber,
      status: status || 'IN_TRANSIT',
      rawStatus: rawStatus || status || 'IN_TRANSIT',
      codAmountCentimes: codAmountCentimes !== null ? BigInt(codAmountCentimes) : (parcel ? parcel.codAmountCentimes : 0n),
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = {
  FakeDeliveryProvider,
  ProviderSandboxAdapter: FakeDeliveryProvider
};
