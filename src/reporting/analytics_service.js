/**
 * BoutiqFlow DZ — Retail Analytics & Operational Intelligence Service (Section 42-45)
 */

const { centimesToDinar } = require('../db/utils');
const { toTenantHour, toTenantDayOfWeek } = require('./timezone_utils');
const { ReportingService } = require('./reporting_service');
const { DEFAULT_TIMEZONE } = require('./constants');

class AnalyticsService {
  /**
   * Top Products ranked by specified metric: 'units', 'revenue', or 'gross_profit' (Section 43)
   */
  static async getTopProducts(tx, { limit = 10, sortBy = 'revenue', ...filters } = {}) {
    const products = await ReportingService.getSalesByProduct(tx, filters);

    if (sortBy === 'units') {
      products.sort((a, b) => b.unitsSold - a.unitsSold);
    } else if (sortBy === 'gross_profit') {
      products.sort((a, b) => Number(b.grossProfitCentimes - a.grossProfitCentimes));
    } else {
      // Default: revenue
      products.sort((a, b) => Number(b.revenueCentimes - a.revenueCentimes));
    }

    return products.slice(0, limit);
  }

  /**
   * Slow Products (lowest sell-through in period)
   */
  static async getSlowProducts(tx, { limit = 10, ...filters } = {}) {
    const products = await ReportingService.getSalesByProduct(tx, filters);
    products.sort((a, b) => a.unitsSold - b.unitsSold);
    return products.slice(0, limit);
  }

  /**
   * Sales distribution by Hour of Day in tenant timezone
   */
  static async getSalesByHour(tx, filters = {}) {
    const tenantId = tx.session.tenantId;
    const timeZone = filters.timeZone || DEFAULT_TIMEZONE;

    const sales = await tx.query('sales', s => s.tenant_id === tenantId && ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(s.status));
    const hours = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      formattedHour: `${String(i).padStart(2, '0')}:00`,
      transactions: 0,
      revenueCentimes: 0n
    }));

    for (const s of sales) {
      const h = toTenantHour(s.created_at, timeZone);
      if (hours[h]) {
        hours[h].transactions++;
        hours[h].revenueCentimes += BigInt(s.total_centimes || 0n);
      }
    }

    return hours.map(h => ({
      ...h,
      revenueDA: centimesToDinar(h.revenueCentimes)
    }));
  }

  /**
   * Sales distribution by Day of Week in tenant timezone
   */
  static async getSalesByDayOfWeek(tx, filters = {}) {
    const tenantId = tx.session.tenantId;
    const timeZone = filters.timeZone || DEFAULT_TIMEZONE;

    const sales = await tx.query('sales', s => s.tenant_id === tenantId && ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(s.status));
    const days = [
      'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
    ];
    const map = {};
    for (const d of days) {
      map[d] = { day: d, transactions: 0, revenueCentimes: 0n };
    }

    for (const s of sales) {
      const dayName = toTenantDayOfWeek(s.created_at, timeZone);
      if (map[dayName]) {
        map[dayName].transactions++;
        map[dayName].revenueCentimes += BigInt(s.total_centimes || 0n);
      }
    }

    return days.map(d => ({
      ...map[d],
      revenueDA: centimesToDinar(map[d].revenueCentimes)
    }));
  }

  /**
   * Sales & Shipments by Algerian Wilaya (1-58)
   */
  static async getSalesByWilaya(tx, filters = {}) {
    const tenantId = tx.session.tenantId;
    const shipments = await tx.query('shipments', s => s.tenant_id === tenantId);

    const wilayaMap = {};

    for (const s of shipments) {
      const snap = s.recipient_snapshot || {};
      const wilaya = snap.wilaya || snap.wilaya_code || 'INCONNUE';
      if (!wilayaMap[wilaya]) {
        wilayaMap[wilaya] = {
          wilaya,
          shipmentsCount: 0,
          deliveredCount: 0,
          returnedCount: 0,
          totalRevenueCentimes: 0n
        };
      }

      wilayaMap[wilaya].shipmentsCount++;
      if (s.status === 'DELIVERED') {
        wilayaMap[wilaya].deliveredCount++;
        wilayaMap[wilaya].totalRevenueCentimes += BigInt(s.cod_amount_centimes || 0n);
      } else if (['RETURN_IN_PROGRESS', 'RETURNED'].includes(s.status)) {
        wilayaMap[wilaya].returnedCount++;
      }
    }

    return Object.values(wilayaMap).sort((a, b) => b.shipmentsCount - a.shipmentsCount);
  }

  /**
   * Return Analytics (Section 44)
   * Grouped by reason, courier, and destination wilaya
   */
  static async getReturnAnalytics(tx, filters = {}) {
    const tenantId = tx.session.tenantId;
    const returns = await tx.query('shipment_returns', r => r.tenant_id === tenantId);
    const shipments = await tx.query('shipments', s => s.tenant_id === tenantId);

    const shipmentMap = new Map(shipments.map(s => [s.id, s]));

    const byReason = {};
    const byCourier = {};
    const byWilaya = {};

    for (const r of returns) {
      const reason = r.reason || 'UNKNOWN_REASON';
      byReason[reason] = (byReason[reason] || 0) + 1;

      const s = shipmentMap.get(r.shipment_id);
      if (s) {
        const courier = s.provider || 'GENERIC';
        byCourier[courier] = (byCourier[courier] || 0) + 1;

        const wilaya = (s.recipient_snapshot && s.recipient_snapshot.wilaya) || 'INCONNUE';
        byWilaya[wilaya] = (byWilaya[wilaya] || 0) + 1;
      }
    }

    return {
      totalReturns: returns.length,
      byReason: Object.entries(byReason).map(([reason, count]) => ({ reason, count })),
      byCourier: Object.entries(byCourier).map(([courier, count]) => ({ courier, count })),
      byWilaya: Object.entries(byWilaya).map(([wilaya, count]) => ({ wilaya, count }))
    };
  }

  /**
   * Stock Turnover Ratio: COGS / Current Stock Valuation (Section 45)
   */
  static async getStockTurnover(tx, filters = {}) {
    const profit = await ReportingService.getProfitSummary(tx, filters);
    const inventory = await ReportingService.getInventorySummary(tx, filters);

    const cogsCentimes = profit.cogsCentimes;
    const stockValuationCentimes = inventory.totalValuationCentimes;

    let turnoverRatio = 'N/A';
    if (stockValuationCentimes > 0n) {
      turnoverRatio = (Number(cogsCentimes * 100n / stockValuationCentimes) / 100).toFixed(2);
    }

    return {
      definition: 'Estimated Stock Turnover = Period COGS / Current Inventory Valuation (Operational metric)',
      cogsCentimes,
      cogsDA: centimesToDinar(cogsCentimes),
      stockValuationCentimes,
      stockValuationDA: centimesToDinar(stockValuationCentimes),
      turnoverRatio
    };
  }
}

module.exports = {
  AnalyticsService
};
