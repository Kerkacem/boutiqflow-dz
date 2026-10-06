/**
 * Standard Courier Adapter Interface for MAHAL
 * Enforces strict polymorphism across all Algerian parcel carriers.
 * Zero customer PII shared with unauthorized third parties.
 */

class CourierAdapter {
  constructor(accountConfig) {
    this.accountId = accountConfig.id;
    this.provider = accountConfig.provider;
    this.apiKey = accountConfig.apiKey;
    this.apiToken = accountConfig.apiToken;
    this.baseUrl = accountConfig.baseUrl;
  }

  async listTerritories() {
    throw new Error('listTerritories() must be implemented by courier adapter');
  }

  async quote({ wilaya, commune, isStopdesk = false, weightKg = 1 }) {
    throw new Error('quote() must be implemented by courier adapter');
  }

  async createShipment({
    orderNumber,
    customerName,
    customerPhone,
    address,
    wilaya,
    commune,
    codAmountCentimes,
    isStopdesk = false
  }) {
    throw new Error('createShipment() must be implemented by courier adapter');
  }

  async track(trackingCode) {
    throw new Error('track() must be implemented by courier adapter');
  }

  async cancel(trackingCode) {
    throw new Error('cancel() must be implemented by courier adapter');
  }

  getLabelUrl(trackingCode) {
    throw new Error('getLabelUrl() must be implemented by courier adapter');
  }
}

module.exports = {
  CourierAdapter
};
