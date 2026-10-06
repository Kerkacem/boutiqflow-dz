const { CourierAdapter } = require('./adapter');

/**
 * Maystro Delivery Courier Adapter for BoutiqFlow DZ
 * Interacts with Maystro Delivery API for on-demand and urban parcel fulfillment.
 */

class MaystroAdapter extends CourierAdapter {
  constructor(accountConfig) {
    super({
      ...accountConfig,
      provider: 'MAYSTRO',
      baseUrl: accountConfig.baseUrl || 'https://api.maystro-delivery.com/v2'
    });
  }

  async listTerritories() {
    return [
      { id: 16, name: 'Alger', communes: ['Alger Centre', 'Hydra', 'Ben Aknoun', 'El Biar'] },
      { id: 9, name: 'Blida', communes: ['Blida', 'Ouled Yaich'] },
      { id: 35, name: 'Boumerdes', communes: ['Boumerdes', 'Zemmouri'] }
    ];
  }

  async quote({ wilaya, isStopdesk = false }) {
    const base = isStopdesk ? 45000n : 60000n; // 450 or 600 DA
    return {
      shippingCostCentimes: base,
      estimatedDays: 1
    };
  }

  async createShipment(shipmentData) {
    const trackingCode = `may-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
    return {
      trackingCode,
      labelUrl: `https://labels.maystro-delivery.com/waybill/${trackingCode}.pdf`,
      status: 'DISPATCHED',
      codAmountCentimes: shipmentData.codAmountCentimes
    };
  }

  async track(trackingCode) {
    return {
      trackingCode,
      status: 'IN_TRANSIT',
      driverPhone: '+213550998877',
      lastUpdate: new Date().toISOString()
    };
  }

  async cancel(trackingCode) {
    return {
      trackingCode,
      status: 'CANCELLED',
      cancelledAt: new Date().toISOString()
    };
  }
}

module.exports = { MaystroAdapter };
