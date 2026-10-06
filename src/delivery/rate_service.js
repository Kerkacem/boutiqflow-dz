/**
 * BoutiqFlow DZ — Delivery Rate & Tariff Service
 * Compares shipping tariffs across multiple carriers for home and stop-desk delivery.
 */

const { DELIVERY_PROVIDERS } = require('./constants');
const { ShipmentService } = require('./shipment_service');

class DeliveryRateService {
  /**
   * Fetches shipping quote from a specific provider
   */
  static async getRate({ provider = DELIVERY_PROVIDERS.YALIDINE, wilaya, commune = null, isStopdesk = false, weightKg = 1 }) {
    const adapter = ShipmentService.getAdapter(provider);
    return await adapter.getRates({ wilaya, commune, isStopdesk, weightKg });
  }

  /**
   * Compares rates across multiple providers
   */
  static async compareRates({ wilaya, commune = null, isStopdesk = false, weightKg = 1 }) {
    const providers = [
      DELIVERY_PROVIDERS.YALIDINE,
      DELIVERY_PROVIDERS.ZR_EXPRESS,
      DELIVERY_PROVIDERS.NOEST,
      DELIVERY_PROVIDERS.MAYSTRO
    ];

    const results = [];
    for (const prov of providers) {
      try {
        const rate = await this.getRate({ provider: prov, wilaya, commune, isStopdesk, weightKg });
        results.push(rate);
      } catch (err) {
        // Skip providers failing rate lookup
      }
    }

    return results.sort((a, b) => (a.shippingFeeCentimes < b.shippingFeeCentimes ? -1 : 1));
  }
}

module.exports = {
  DeliveryRateService
};
