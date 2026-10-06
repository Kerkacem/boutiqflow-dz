const { CourierAdapter } = require('./adapter');
const crypto = require('crypto');

/**
 * Ecotrack Engine Family Adapter
 * Supports configurable base URL for couriers utilizing the Ecotrack backend.
 */
class EcotrackAdapter extends CourierAdapter {
  constructor(accountConfig) {
    super({
      ...accountConfig,
      provider: 'ECOTRACK',
      baseUrl: accountConfig.baseUrl || 'https://api.ecotrack.dz/api/v1'
    });
  }

  async listTerritories() {
    return [
      { id: 16, name: 'Alger', communes: ['Bab Ezzouar', 'Dar El Beida', 'Bordj El Kiffan'] },
      { id: 31, name: 'Oran', communes: ['Ain El Turk', 'Arzew'] }
    ];
  }

  async quote({ wilaya, isStopdesk = false }) {
    const isAlgiers = wilaya.toLowerCase().includes('alger') || wilaya === '16';
    const costDA = isAlgiers ? (isStopdesk ? 200 : 350) : (isStopdesk ? 400 : 650);
    return {
      provider: 'ECOTRACK',
      shippingCostCentimes: BigInt(costDA * 100),
      estimatedDeliveryDays: isAlgiers ? 1 : 2
    };
  }

  async createShipment({ orderNumber, customerName, customerPhone, address, wilaya, commune, codAmountCentimes, isStopdesk }) {
    const randomSuffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    const trackingCode = `eco-${randomSuffix}`;
    const quote = await this.quote({ wilaya, isStopdesk });

    return {
      success: true,
      provider: 'ECOTRACK',
      trackingCode,
      labelUrl: this.getLabelUrl(trackingCode),
      shippingCostCentimes: quote.shippingCostCentimes,
      codAmountCentimes: BigInt(codAmountCentimes),
      status: 'SHIPPED',
      createdAt: new Date().toISOString()
    };
  }

  async track(trackingCode) {
    return { trackingCode, provider: 'ECOTRACK', status: 'IN_TRANSIT' };
  }

  async cancel(trackingCode) {
    return { success: true, trackingCode, status: 'CANCELLED' };
  }

  getLabelUrl(trackingCode) {
    return `${this.baseUrl}/shipments/${trackingCode}/label.pdf`;
  }
}

/**
 * ZR Express Courier Adapter
 */
class ZrExpressAdapter extends CourierAdapter {
  constructor(accountConfig) {
    super({
      ...accountConfig,
      provider: 'ZR_EXPRESS',
      baseUrl: accountConfig.baseUrl || 'https://api.zrexpress.dz/v1'
    });
  }

  async listTerritories() {
    return [
      { id: 16, name: 'Alger', communes: ['Birtouta', 'Zeralda'] }
    ];
  }

  async quote({ wilaya, isStopdesk = false }) {
    return {
      provider: 'ZR_EXPRESS',
      shippingCostCentimes: 50000n, // 500 DA
      estimatedDeliveryDays: 2
    };
  }

  async createShipment({ orderNumber, customerName, customerPhone, address, wilaya, commune, codAmountCentimes, isStopdesk }) {
    const randomSuffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    const trackingCode = `zr-${randomSuffix}`;

    return {
      success: true,
      provider: 'ZR_EXPRESS',
      trackingCode,
      labelUrl: this.getLabelUrl(trackingCode),
      shippingCostCentimes: 50000n,
      codAmountCentimes: BigInt(codAmountCentimes),
      status: 'SHIPPED',
      createdAt: new Date().toISOString()
    };
  }

  async track(trackingCode) {
    return { trackingCode, provider: 'ZR_EXPRESS', status: 'IN_TRANSIT' };
  }

  async cancel(trackingCode) {
    return { success: true, trackingCode, status: 'CANCELLED' };
  }

  getLabelUrl(trackingCode) {
    return `${this.baseUrl}/tickets/${trackingCode}/print`;
  }
}

module.exports = {
  EcotrackAdapter,
  ZrExpressAdapter
};
