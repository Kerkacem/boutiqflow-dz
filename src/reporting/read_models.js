/**
 * BoutiqFlow DZ — Reporting Read Models & Event Ingestion (INV-09-07, INV-09-08, INV-09-09)
 * Provides rebuildable, materialized summary tables and idempotent reporting event processing.
 */

const { generateUUIDv7, centimesToDinar } = require('../db/utils');
const { toTenantDayKey } = require('./timezone_utils');
const { DEFAULT_TIMEZONE, METRIC_VERSIONS } = require('./constants');

class ReadModelService {
  /**
   * Idempotently ingests a canonical reporting event into reporting_events_log (INV-09-07)
   */
  static async ingestReportingEvent(tx, {
    eventId,
    eventType,
    timestamp = new Date().toISOString(),
    payload = {}
  }) {
    const tenantId = tx.session.tenantId;

    if (!eventId) {
      throw new Error('Reporting Event Error: eventId is strictly required (INV-09-07)');
    }

    // 1. Check idempotency: Replaying identical eventId is a safe no-op
    const existing = await tx.query('reporting_events_log', e =>
      e.tenant_id === tenantId && e.event_id === eventId
    );

    if (existing.length > 0) {
      return {
        replayed: true,
        event: existing[0]
      };
    }

    // 2. Insert event record in append-only log
    const eventRecord = await tx.insert('reporting_events_log', {
      id: generateUUIDv7(),
      event_id: eventId,
      event_type: eventType,
      timestamp,
      payload,
      created_at: new Date().toISOString()
    });

    // 3. Incrementally update daily summaries
    await this._applyEventToReadModels(tx, { eventType, payload, timestamp });

    return {
      replayed: false,
      event: eventRecord
    };
  }

  /**
   * Applies single event to daily read models
   */
  static async _applyEventToReadModels(tx, { eventType, payload, timestamp }) {
    const tenantId = tx.session.tenantId;
    const dayKey = toTenantDayKey(timestamp, DEFAULT_TIMEZONE);

    if (eventType === 'SALE_RECOGNIZED') {
      const summaries = await tx.query('daily_sales_summaries', s =>
        s.tenant_id === tenantId && s.day_key === dayKey
      );

      const netRev = BigInt(payload.totalCentimes || 0n);
      const units = Number(payload.units || 0);

      if (summaries.length > 0) {
        const s = summaries[0];
        await tx.update('daily_sales_summaries', s.id, {
          transactions_count: s.transactions_count + 1,
          units_sold: s.units_sold + units,
          net_revenue_centimes: BigInt(s.net_revenue_centimes) + netRev,
          updated_at: new Date().toISOString()
        });
      } else {
        await tx.insert('daily_sales_summaries', {
          id: generateUUIDv7(),
          tenant_id: tenantId,
          day_key: dayKey,
          transactions_count: 1,
          units_sold: units,
          net_revenue_centimes: netRev,
          version: METRIC_VERSIONS.REVENUE,
          created_at: new Date().toISOString()
        });
      }
    }
  }

  /**
   * Authoritatively rebuilds all read models from canonical transactional tables (INV-09-08, INV-09-09)
   */
  static async rebuildReadModels(tx) {
    const tenantId = tx.session.tenantId;

    // 1. Clear existing read model tables for this tenant
    const oldDailySales = await tx.query('daily_sales_summaries', s => s.tenant_id === tenantId);
    for (const r of oldDailySales) await tx.delete('daily_sales_summaries', r.id);

    const oldDailyProfit = await tx.query('daily_profit_summaries', p => p.tenant_id === tenantId);
    for (const r of oldDailyProfit) await tx.delete('daily_profit_summaries', r.id);

    const oldInventorySummaries = await tx.query('inventory_summaries', i => i.tenant_id === tenantId);
    for (const r of oldInventorySummaries) await tx.delete('inventory_summaries', r.id);

    // 2. Rebuild Daily Sales & Profit from canonical sales and sale_items
    const sales = await tx.query('sales', s =>
      s.tenant_id === tenantId && ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(s.status)
    );

    const saleItems = await tx.query('sale_items', si => si.tenant_id === tenantId);
    const saleItemMap = new Map();
    for (const item of saleItems) {
      if (!saleItemMap.has(item.sale_id)) saleItemMap.set(item.sale_id, []);
      saleItemMap.get(item.sale_id).push(item);
    }

    const expenses = await tx.query('expenses', e => e.tenant_id === tenantId && e.status === 'POSTED');

    const dayMap = new Map();

    for (const sale of sales) {
      const day = toTenantDayKey(sale.created_at, DEFAULT_TIMEZONE);
      if (!dayMap.has(day)) {
        dayMap.set(day, {
          dayKey: day,
          transactions: 0,
          unitsSold: 0,
          revenueCentimes: 0n,
          cogsCentimes: 0n,
          expenseCentimes: 0n
        });
      }

      const rec = dayMap.get(day);
      rec.transactions++;
      rec.revenueCentimes += BigInt(sale.total_centimes || 0n);

      const items = saleItemMap.get(sale.id) || [];
      for (const it of items) {
        rec.unitsSold += it.qty;
        const unitCost = BigInt(it.cost_snapshot_centimes !== undefined ? it.cost_snapshot_centimes : (it.cost_price_centimes || 0n));
        rec.cogsCentimes += unitCost * BigInt(it.qty);
      }
    }

    for (const exp of expenses) {
      const day = toTenantDayKey(exp.created_at, DEFAULT_TIMEZONE);
      if (!dayMap.has(day)) {
        dayMap.set(day, {
          dayKey: day,
          transactions: 0,
          unitsSold: 0,
          revenueCentimes: 0n,
          cogsCentimes: 0n,
          expenseCentimes: 0n
        });
      }
      dayMap.get(day).expenseCentimes += BigInt(exp.amount_centimes || 0n);
    }

    for (const [day, data] of dayMap.entries()) {
      await tx.insert('daily_sales_summaries', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        day_key: day,
        transactions_count: data.transactions,
        units_sold: data.unitsSold,
        net_revenue_centimes: data.revenueCentimes,
        version: METRIC_VERSIONS.REVENUE,
        rebuilt_at: new Date().toISOString()
      });

      const grossProfit = data.revenueCentimes - data.cogsCentimes;
      const operatingProfit = grossProfit - data.expenseCentimes;

      await tx.insert('daily_profit_summaries', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        day_key: day,
        revenue_centimes: data.revenueCentimes,
        cogs_centimes: data.cogsCentimes,
        gross_profit_centimes: grossProfit,
        expenses_centimes: data.expenseCentimes,
        operating_profit_centimes: operatingProfit,
        version: METRIC_VERSIONS.PROFIT,
        rebuilt_at: new Date().toISOString()
      });
    }

    // 3. Rebuild Inventory Summaries from stock_levels
    const levels = await tx.query('stock_levels', sl => sl.tenant_id === tenantId);
    let totalOnHand = 0;
    let totalReserved = 0;
    let totalValuation = 0n;

    for (const sl of levels) {
      const v = await tx.findById('product_variants', sl.variant_id);
      totalOnHand += sl.on_hand;
      totalReserved += sl.reserved;
      if (v) {
        totalValuation += BigInt(sl.on_hand) * BigInt(v.cost_price || 0n);
      }
    }

    await tx.insert('inventory_summaries', {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      total_on_hand: totalOnHand,
      total_reserved: totalReserved,
      total_available: totalOnHand - totalReserved,
      total_valuation_centimes: totalValuation,
      version: METRIC_VERSIONS.INVENTORY_VALUATION,
      rebuilt_at: new Date().toISOString()
    });

    return {
      success: true,
      rebuiltDaysCount: dayMap.size,
      totalValuationCentimes: totalValuation,
      rebuiltAt: new Date().toISOString()
    };
  }
}

module.exports = {
  ReadModelService
};
