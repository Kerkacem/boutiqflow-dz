/**
 * BoutiqFlow DZ — Authoritative Reporting Service (INV-09-01, INV-09-02, INV-09-04)
 * Pure Read-Only aggregation layer over canonical transactional data.
 * Reports never mutate transactional state and never become a second source of truth.
 */

const { centimesToDinar } = require('../db/utils');
const { resolveDateRangeFilter, toTenantDayKey } = require('./timezone_utils');
const {
  METRIC_VERSIONS,
  DEFAULT_TIMEZONE,
  MINIMUM_PROVIDER_SAMPLE,
  REPORT_ERRORS
} = require('./constants');

class ReportingService {
  /**
   * Helper to ensure tenant boundary is respected from session (INV-09-03, INV-09-20)
   */
  static _enforceTenant(tx, filters = {}) {
    const sessionTenantId = tx.session.tenantId;
    if (filters.tenantId && filters.tenantId !== sessionTenantId) {
      const err = new Error('Security Violation: User-supplied tenantId does not match authenticated context (INV-09-03, INV-09-20)');
      err.code = 'TENANT_MISMATCH';
      throw err;
    }
    return sessionTenantId;
  }

  /**
   * Safely calculates percentage change between previous and current BigInt/numbers
   */
  static checkReportAccess(role, reportType) {
    const r = (role || '').toLowerCase();
    if (['profit', 'cogs', 'suppliers', 'expenses', 'financial'].includes(reportType)) {
      if (!['owner', 'manager', 'accountant'].includes(r)) {
        const err = new Error(`Access Denied: Role '${role}' is not authorized to view '${reportType}' reports (INV-09-10)`);
        err.code = 'UNAUTHORIZED_REPORT';
        throw err;
      }
    }
    if (['export'].includes(reportType)) {
      if (!['owner', 'manager', 'accountant'].includes(r)) {
        const err = new Error(`Access Denied: Role '${role}' is not authorized to export reports (INV-09-16)`);
        err.code = 'UNAUTHORIZED_REPORT';
        throw err;
      }
    }
    return true;
  }

  static _calculatePercentageChange(current, previous) {
    const curr = typeof current === 'bigint' ? Number(current) : Number(current || 0);
    const prev = typeof previous === 'bigint' ? Number(previous) : Number(previous || 0);

    if (prev === 0) {
      if (curr === 0) return '0%';
      return 'New'; // Safe indicator without dividing by zero (INV-09-12)
    }

    const change = ((curr - prev) / Math.abs(prev)) * 100;
    const sign = change > 0 ? '+' : '';
    return `${sign}${change.toFixed(1)}%`;
  }

  /**
   * 1. SALES REPORT (Section 10)
   * Gross Sales, Discounts, Net Revenue, Transactions, Units Sold, Average Basket, Refunds
   */
  static async getSalesSummary(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);
    const timeZone = filters.timeZone || DEFAULT_TIMEZONE;
    const { startUtc, endUtc } = resolveDateRangeFilter({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, timeZone });

    // 1. Fetch completed POS sales
    const sales = await tx.query('sales', s => {
      if (s.tenant_id !== tenantId) return false;
      if (!['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(s.status)) return false;
      if (startUtc && s.created_at < startUtc) return false;
      if (endUtc && s.created_at > endUtc) return false;
      if (filters.locationId && s.location_id !== filters.locationId) return false;
      if (filters.registerId && s.register_id !== filters.registerId) return false;
      if (filters.cashierId && s.cashier_id !== filters.cashierId) return false;
      return true;
    });

    const saleIds = new Set(sales.map(s => s.id));

    // 2. Fetch sale items
    const saleItems = await tx.query('sale_items', si => {
      if (si.tenant_id !== tenantId) return false;
      if (!saleIds.has(si.sale_id)) return false;
      if (filters.variantId && si.variant_id !== filters.variantId) return false;
      if (filters.productId && si.product_id !== filters.productId) return false;
      return true;
    });

    // 3. Fetch refunds in date range
    const refunds = await tx.query('refunds', r => {
      if (r.tenant_id !== tenantId) return false;
      if (startUtc && r.created_at < startUtc) return false;
      if (endUtc && r.created_at > endUtc) return false;
      if (filters.locationId && r.location_id !== filters.locationId) return false;
      return true;
    });

    let grossSalesCentimes = 0n;
    let discountsCentimes = 0n;
    let totalUnitsSold = 0;
    let historicalCogsCentimes = 0n;

    for (const s of sales) {
      grossSalesCentimes += BigInt(s.subtotal_centimes || 0n);
      discountsCentimes += BigInt(s.discount_centimes || 0n);
    }

    for (const item of saleItems) {
      totalUnitsSold += item.qty;
      const unitCost = BigInt(item.cost_snapshot_centimes !== undefined ? item.cost_snapshot_centimes : (item.cost_price_centimes || 0n));
      historicalCogsCentimes += unitCost * BigInt(item.qty);
    }

    let refundAmountCentimes = 0n;
    for (const r of refunds) {
      refundAmountCentimes += BigInt(r.amount_centimes || 0n);
    }

    const netSalesCentimes = grossSalesCentimes - discountsCentimes;
    const netRevenueCentimes = netSalesCentimes - refundAmountCentimes;
    const transactionsCount = sales.length;

    const averageBasketCentimes = transactionsCount > 0
      ? netRevenueCentimes / BigInt(transactionsCount)
      : 0n;

    return {
      definitionVersion: METRIC_VERSIONS.REVENUE,
      transactionsCount,
      unitsSold: totalUnitsSold,
      grossSalesCentimes,
      grossSalesDA: centimesToDinar(grossSalesCentimes),
      discountsCentimes,
      discountsDA: centimesToDinar(discountsCentimes),
      refundAmountCentimes,
      refundAmountDA: centimesToDinar(refundAmountCentimes),
      netRevenueCentimes,
      netRevenueDA: centimesToDinar(netRevenueCentimes),
      averageBasketCentimes,
      averageBasketDA: centimesToDinar(averageBasketCentimes),
      historicalCogsCentimes,
      historicalCogsDA: centimesToDinar(historicalCogsCentimes)
    };
  }

  /**
   * 2. SALES BY PRODUCT (Section 11)
   * Product, Variant, SKU, Units, Revenue, COGS, Gross Profit, Margin %
   */
  static async getSalesByProduct(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);
    const timeZone = filters.timeZone || DEFAULT_TIMEZONE;
    const { startUtc, endUtc } = resolveDateRangeFilter({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, timeZone });

    const sales = await tx.query('sales', s => {
      if (s.tenant_id !== tenantId) return false;
      if (!['COMPLETED', 'PARTIALLY_REFUNDED'].includes(s.status)) return false;
      if (startUtc && s.created_at < startUtc) return false;
      if (endUtc && s.created_at > endUtc) return false;
      return true;
    });
    const saleIds = new Set(sales.map(s => s.id));

    const items = await tx.query('sale_items', si => {
      if (si.tenant_id !== tenantId) return false;
      return saleIds.has(si.sale_id);
    });

    const productMap = new Map();

    for (const item of items) {
      const vId = item.variant_id;
      if (!productMap.has(vId)) {
        productMap.set(vId, {
          variantId: vId,
          productId: item.product_id,
          productName: item.product_name || 'Article',
          sku: item.sku || '',
          size: item.size || '',
          color: item.color || '',
          unitsSold: 0,
          revenueCentimes: 0n,
          cogsCentimes: 0n
        });
      }

      const rec = productMap.get(vId);
      rec.unitsSold += item.qty;
      rec.revenueCentimes += BigInt(item.total_centimes || (BigInt(item.unit_price_centimes) * BigInt(item.qty)));

      // Strict Historical COGS snapshot (INV-09-04, INV-09-05)
      const unitCost = BigInt(item.cost_snapshot_centimes !== undefined ? item.cost_snapshot_centimes : (item.cost_price_centimes || 0n));
      rec.cogsCentimes += unitCost * BigInt(item.qty);
    }

    const rows = Array.from(productMap.values()).map(r => {
      const grossProfitCentimes = r.revenueCentimes - r.cogsCentimes;
      let marginFormatted = 'N/A';
      if (r.revenueCentimes > 0n) {
        const pct = (Number(grossProfitCentimes * 10000n / r.revenueCentimes) / 100).toFixed(2);
        marginFormatted = `${pct}%`;
      }
      return {
        ...r,
        revenueDA: centimesToDinar(r.revenueCentimes),
        cogsDA: centimesToDinar(r.cogsCentimes),
        grossProfitCentimes,
        grossProfitDA: centimesToDinar(grossProfitCentimes),
        marginPercent: marginFormatted
      };
    });

    return rows.sort((a, b) => Number(b.revenueCentimes - a.revenueCentimes));
  }

  /**
   * 3. CATEGORY REPORT (Section 13)
   */
  static async getSalesByCategory(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);
    const byProduct = await this.getSalesByProduct(tx, filters);

    const categoryMap = new Map();

    for (const p of byProduct) {
      const product = await tx.findById('products', p.productId);
      const cat = (product && product.category) ? product.category : 'Non catégorisé';

      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, {
          category: cat,
          unitsSold: 0,
          revenueCentimes: 0n,
          cogsCentimes: 0n
        });
      }

      const c = categoryMap.get(cat);
      c.unitsSold += p.unitsSold;
      c.revenueCentimes += p.revenueCentimes;
      c.cogsCentimes += p.cogsCentimes;
    }

    return Array.from(categoryMap.values()).map(c => {
      const grossProfitCentimes = c.revenueCentimes - c.cogsCentimes;
      let marginPercent = 'N/A';
      if (c.revenueCentimes > 0n) {
        marginPercent = `${(Number(grossProfitCentimes * 10000n / c.revenueCentimes) / 100).toFixed(2)}%`;
      }
      return {
        ...c,
        revenueDA: centimesToDinar(c.revenueCentimes),
        cogsDA: centimesToDinar(c.cogsCentimes),
        grossProfitCentimes,
        grossProfitDA: centimesToDinar(grossProfitCentimes),
        marginPercent
      };
    });
  }

  /**
   * 4. INVENTORY REPORT (Section 14)
   * Variant, SKU, OnHand, Reserved, Available, Current WAC, Current Stock Valuation
   */
  static async getInventorySummary(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);

    const levels = await tx.query('stock_levels', sl => {
      if (sl.tenant_id !== tenantId) return false;
      if (filters.locationId && sl.location_id !== filters.locationId) return false;
      return true;
    });

    const rows = [];
    let totalOnHand = 0;
    let totalReserved = 0;
    let totalAvailable = 0;
    let totalValuationCentimes = 0n;

    for (const sl of levels) {
      const variant = await tx.findById('product_variants', sl.variant_id);
      if (!variant) continue;
      const product = await tx.findById('products', variant.product_id);

      const available = sl.on_hand - sl.reserved;
      const wac = BigInt(variant.cost_price || 0n);
      const stockValueCentimes = BigInt(sl.on_hand) * wac;

      totalOnHand += sl.on_hand;
      totalReserved += sl.reserved;
      totalAvailable += available;
      totalValuationCentimes += stockValueCentimes;

      rows.push({
        variantId: variant.id,
        productId: variant.product_id,
        productName: product ? product.name : 'Article',
        sku: variant.sku,
        size: variant.size,
        color: variant.color,
        locationId: sl.location_id,
        onHand: sl.on_hand,
        reserved: sl.reserved,
        available,
        weightedAverageCostCentimes: wac,
        weightedAverageCostDA: centimesToDinar(wac),
        stockValueCentimes,
        stockValueDA: centimesToDinar(stockValueCentimes)
      });
    }

    return {
      definitionVersion: METRIC_VERSIONS.INVENTORY_VALUATION,
      totalVariantsCount: rows.length,
      totalOnHand,
      totalReserved,
      totalAvailable,
      totalValuationCentimes,
      totalValuationDA: centimesToDinar(totalValuationCentimes),
      variants: rows
    };
  }

  /**
   * 5. LOW STOCK REPORT (Section 15)
   * Identifies variants where available <= reorderPoint
   */
  static async getLowStockReport(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);
    const defaultReorderPoint = filters.reorderPoint !== undefined ? filters.reorderPoint : 5;

    const inventory = await this.getInventorySummary(tx, filters);
    const lowStockItems = [];

    for (const item of inventory.variants) {
      const threshold = item.reorderPoint !== undefined ? item.reorderPoint : defaultReorderPoint;
      if (item.available <= threshold) {
        lowStockItems.push({
          ...item,
          reorderPoint: threshold,
          recommendedAction: item.available === 0 ? 'RUPTURE_IMMEDIATE_ORDER' : 'REORDER_RECOMMENDED'
        });
      }
    }

    return lowStockItems.sort((a, b) => a.available - b.available);
  }

  /**
   * 6. INVENTORY AGING REPORT (Section 16)
   * Tracks age since last stock movement: 0-30, 31-60, 61-90, 90+ days
   */
  static async getInventoryAgingReport(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);
    const now = Date.now();

    const levels = await tx.query('stock_levels', sl => sl.tenant_id === tenantId && sl.on_hand > 0);
    const movements = await tx.query('stock_movements', sm => sm.tenant_id === tenantId);

    const lastMovementMap = new Map();
    for (const sm of movements) {
      const t = new Date(sm.created_at).getTime();
      const prev = lastMovementMap.get(sm.variant_id) || 0;
      if (t > prev) lastMovementMap.set(sm.variant_id, t);
    }

    const agingBuckets = {
      '0_30': { label: '0-30 jours', count: 0, totalUnits: 0, valuationCentimes: 0n },
      '31_60': { label: '31-60 jours', count: 0, totalUnits: 0, valuationCentimes: 0n },
      '61_90': { label: '61-90 jours', count: 0, totalUnits: 0, valuationCentimes: 0n },
      '90_plus': { label: '90+ jours (Dead Stock)', count: 0, totalUnits: 0, valuationCentimes: 0n }
    };

    for (const sl of levels) {
      const variant = await tx.findById('product_variants', sl.variant_id);
      if (!variant) continue;

      const lastTime = lastMovementMap.get(sl.variant_id) || new Date(sl.updated_at || sl.created_at).getTime();
      const days = Math.floor((now - lastTime) / (24 * 3600 * 1000));
      const val = BigInt(sl.on_hand) * BigInt(variant.cost_price || 0n);

      let bucketKey = '0_30';
      if (days > 90) bucketKey = '90_plus';
      else if (days > 60) bucketKey = '61_90';
      else if (days > 30) bucketKey = '31_60';

      agingBuckets[bucketKey].count++;
      agingBuckets[bucketKey].totalUnits += sl.on_hand;
      agingBuckets[bucketKey].valuationCentimes += val;
    }

    return Object.entries(agingBuckets).map(([key, data]) => ({
      bucket: key,
      label: data.label,
      variantsCount: data.count,
      totalUnits: data.totalUnits,
      valuationCentimes: data.valuationCentimes,
      valuationDA: centimesToDinar(data.valuationCentimes)
    }));
  }

  /**
   * 7. CASH REPORT (Section 17)
   */
  static async getCashSummary(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);
    const timeZone = filters.timeZone || DEFAULT_TIMEZONE;
    const { startUtc, endUtc } = resolveDateRangeFilter({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, timeZone });

    const sessions = await tx.query('register_sessions', s => {
      if (s.tenant_id !== tenantId) return false;
      if (filters.registerId && s.register_id !== filters.registerId) return false;
      if (filters.cashierId && s.cashier_id !== filters.cashierId) return false;
      if (startUtc && s.created_at < startUtc) return false;
      if (endUtc && s.created_at > endUtc) return false;
      return true;
    });

    const sessionIds = new Set(sessions.map(s => s.id));

    const cashTxs = await tx.query('cash_transactions', ct => {
      if (ct.tenant_id !== tenantId) return false;
      return sessionIds.has(ct.session_id);
    });

    let totalOpeningFloatCentimes = 0n;
    let totalCashSalesCentimes = 0n;
    let totalCashRefundsCentimes = 0n;
    let totalCashAdjustmentsCentimes = 0n;

    for (const s of sessions) {
      totalOpeningFloatCentimes += BigInt(s.opening_cash_centimes || s.opening_float_centimes || 0n);
    }

    for (const ct of cashTxs) {
      const amt = BigInt(ct.amount_centimes || 0n);
      if (ct.type === 'SALE_CASH') {
        totalCashSalesCentimes += amt;
      } else if (ct.type === 'REFUND_CASH') {
        totalCashRefundsCentimes += amt;
      } else if (ct.type === 'CASH_IN') {
        totalCashAdjustmentsCentimes += amt;
      } else if (ct.type === 'CASH_OUT') {
        totalCashAdjustmentsCentimes -= amt;
      }
    }

    const expectedClosingCashCentimes = totalOpeningFloatCentimes + totalCashSalesCentimes - totalCashRefundsCentimes + totalCashAdjustmentsCentimes;

    return {
      sessionsCount: sessions.length,
      openingFloatCentimes: totalOpeningFloatCentimes,
      openingFloatDA: centimesToDinar(totalOpeningFloatCentimes),
      cashSalesCentimes: totalCashSalesCentimes,
      cashSalesDA: centimesToDinar(totalCashSalesCentimes),
      cashRefundsCentimes: totalCashRefundsCentimes,
      cashRefundsDA: centimesToDinar(totalCashRefundsCentimes),
      cashAdjustmentsCentimes: totalCashAdjustmentsCentimes,
      cashAdjustmentsDA: centimesToDinar(totalCashAdjustmentsCentimes),
      expectedClosingCashCentimes,
      expectedClosingCashDA: centimesToDinar(expectedClosingCashCentimes)
    };
  }

  /**
   * 8. PAYMENT METHODS REPORT (Section 18)
   */
  static async getPaymentSummary(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);
    const timeZone = filters.timeZone || DEFAULT_TIMEZONE;
    const { startUtc, endUtc } = resolveDateRangeFilter({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, timeZone });

    const sales = await tx.query('sales', s => {
      if (s.tenant_id !== tenantId) return false;
      if (!['COMPLETED', 'PARTIALLY_REFUNDED'].includes(s.status)) return false;
      if (startUtc && s.created_at < startUtc) return false;
      if (endUtc && s.created_at > endUtc) return false;
      return true;
    });
    const saleIds = new Set(sales.map(s => s.id));

    const payments = await tx.query('sale_payments', sp => {
      if (sp.tenant_id !== tenantId) return false;
      return saleIds.has(sp.sale_id);
    });

    const summary = {
      CASH: { method: 'Espèces (CASH)', transactions: 0, amountCentimes: 0n },
      CARD: { method: 'Carte CIB/Dahabia (CARD)', transactions: 0, amountCentimes: 0n },
      BARIDIMOB: { method: 'BaridiMob (BARIDIMOB)', transactions: 0, amountCentimes: 0n },
      CUSTOMER_CREDIT: { method: 'Crédit client (CUSTOMER_CREDIT)', transactions: 0, amountCentimes: 0n }
    };

    for (const p of payments) {
      const tender = p.tender_type || 'CASH';
      if (!summary[tender]) {
        summary[tender] = { method: tender, transactions: 0, amountCentimes: 0n };
      }
      summary[tender].transactions++;
      summary[tender].amountCentimes += BigInt(p.amount_centimes || 0n);
    }

    return Object.values(summary).map(s => ({
      ...s,
      amountDA: centimesToDinar(s.amountCentimes)
    }));
  }

  /**
   * 9. ONLINE ORDER FUNNEL (Section 19)
   */
  static async getOnlineOrderFunnel(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);
    const timeZone = filters.timeZone || DEFAULT_TIMEZONE;
    const { startUtc, endUtc } = resolveDateRangeFilter({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, timeZone });

    const orders = await tx.query('online_orders', o => {
      if (o.tenant_id !== tenantId) return false;
      if (startUtc && o.created_at < startUtc) return false;
      if (endUtc && o.created_at > endUtc) return false;
      return true;
    });

    const counts = {
      TOTAL_CREATED: orders.length,
      NEW: 0,
      PENDING_CONFIRMATION: 0,
      CONFIRMED: 0,
      RESERVED: 0,
      PREPARING: 0,
      READY_TO_SHIP: 0,
      SHIPPED: 0,
      DELIVERED: 0,
      FAILED_DELIVERY: 0,
      REFUSED: 0,
      CANCELLED: 0,
      RETURNED: 0
    };

    for (const o of orders) {
      if (counts[o.status] !== undefined) {
        counts[o.status]++;
      }
    }

    // Explicit ratios with exact denominators (INV-09-12)
    const confirmedPopulation = counts.TOTAL_CREATED;
    const confirmationRate = confirmedPopulation > 0
      ? `${(((counts.TOTAL_CREATED - counts.CANCELLED - counts.NEW - counts.PENDING_CONFIRMATION) / confirmedPopulation) * 100).toFixed(1)}%`
      : 'N/A';

    const deliveryOutcomePopulation = counts.DELIVERED + counts.REFUSED + counts.RETURNED + counts.FAILED_DELIVERY;
    const deliverySuccessRate = deliveryOutcomePopulation > 0
      ? `${((counts.DELIVERED / deliveryOutcomePopulation) * 100).toFixed(1)}%`
      : 'N/A';

    const refusalRate = deliveryOutcomePopulation > 0
      ? `${((counts.REFUSED / deliveryOutcomePopulation) * 100).toFixed(1)}%`
      : 'N/A';

    const returnRate = deliveryOutcomePopulation > 0
      ? `${((counts.RETURNED / deliveryOutcomePopulation) * 100).toFixed(1)}%`
      : 'N/A';

    return {
      counts,
      ratios: {
        confirmationRate,
        deliverySuccessRate,
        refusalRate,
        returnRate
      }
    };
  }

  /**
   * 10. COD ANALYTICS (Section 20)
   * Delivered != Collected != Settled (INV-09-13)
   */
  static async getCODAnalytics(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);

    const shipments = await tx.query('shipments', s => s.tenant_id === tenantId);
    const collections = await tx.query('courier_collections', c => c.tenant_id === tenantId);
    const settlements = await tx.query('courier_settlements', s => s.tenant_id === tenantId);

    let codExpectedCentimes = 0n;
    for (const s of shipments) {
      if (['DELIVERED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT'].includes(s.status)) {
        codExpectedCentimes += BigInt(s.cod_amount_centimes || 0n);
      }
    }

    let codCollectedCentimes = 0n;
    for (const c of collections) {
      codCollectedCentimes += BigInt(c.amount_collected_centimes || 0n);
    }

    let codSettledCentimes = 0n;
    for (const s of settlements) {
      codSettledCentimes += BigInt(s.settlement_amount_centimes || s.amount_centimes || 0n);
    }

    const codOutstandingCentimes = codExpectedCentimes > codSettledCentimes ? codExpectedCentimes - codSettledCentimes : 0n;
    const codUnderSettledCentimes = codCollectedCentimes > codSettledCentimes ? codCollectedCentimes - codSettledCentimes : 0n;

    return {
      definitionVersion: METRIC_VERSIONS.DELIVERY_RATE,
      codExpectedCentimes,
      codExpectedDA: centimesToDinar(codExpectedCentimes),
      codCollectedCentimes,
      codCollectedDA: centimesToDinar(codCollectedCentimes),
      codSettledCentimes,
      codSettledDA: centimesToDinar(codSettledCentimes),
      codOutstandingCentimes,
      codOutstandingDA: centimesToDinar(codOutstandingCentimes),
      codUnderSettledCentimes,
      codUnderSettledDA: centimesToDinar(codUnderSettledCentimes)
    };
  }

  /**
   * 11. DELIVERY PROVIDER REPORT & COMPARISON (Sections 21 & 22)
   */
  static async getDeliverySummary(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);
    const shipments = await tx.query('shipments', s => s.tenant_id === tenantId);

    const providerMap = new Map();

    for (const s of shipments) {
      const p = s.provider || 'GENERIC';
      if (!providerMap.has(p)) {
        providerMap.set(p, {
          provider: p,
          totalShipments: 0,
          deliveredCount: 0,
          failedCount: 0,
          returnedCount: 0,
          inTransitCount: 0,
          totalDurationHours: 0,
          completedDurationCount: 0
        });
      }

      const row = providerMap.get(p);
      row.totalShipments++;

      if (s.status === 'DELIVERED') {
        row.deliveredCount++;
        if (s.picked_up_at && s.delivered_at) {
          const duration = (new Date(s.delivered_at) - new Date(s.picked_up_at)) / (3600 * 1000);
          if (duration >= 0) {
            row.totalDurationHours += duration;
            row.completedDurationCount++;
          }
        }
      } else if (['FAILED_DELIVERY', 'REFUSED'].includes(s.status)) {
        row.failedCount++;
      } else if (['RETURN_IN_PROGRESS', 'RETURNED'].includes(s.status)) {
        row.returnedCount++;
      } else if (['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'PICKED_UP'].includes(s.status)) {
        row.inTransitCount++;
      }
    }

    return Array.from(providerMap.values()).map(r => {
      const isSufficientSample = r.totalShipments >= MINIMUM_PROVIDER_SAMPLE;
      const successRate = r.totalShipments > 0
        ? `${((r.deliveredCount / r.totalShipments) * 100).toFixed(1)}%`
        : 'N/A';
      const avgDurationHours = r.completedDurationCount > 0
        ? (r.totalDurationHours / r.completedDurationCount).toFixed(1)
        : 'N/A';

      return {
        ...r,
        isSufficientSample,
        deliverySuccessRate: isSufficientSample ? successRate : 'INSUFFICIENT_SAMPLE',
        averageDurationHours: isSufficientSample ? avgDurationHours : 'INSUFFICIENT_SAMPLE'
      };
    });
  }

  /**
   * 12. SUPPLIER REPORT (Section 23)
   */
  static async getSupplierSummary(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);
    if (filters.actorRole) {
      this.checkReportAccess(filters.actorRole, 'suppliers');
    }

    const suppliers = await tx.query('suppliers', s => s.tenant_id === tenantId);
    const receipts = await tx.query('purchase_receipts', r => r.tenant_id === tenantId);
    const returns = await tx.query('purchase_returns', r => r.tenant_id === tenantId);
    const payments = await tx.query('supplier_payments', sp => sp.tenant_id === tenantId);

    const res = [];
    for (const sup of suppliers) {
      const supReceipts = receipts.filter(r => r.supplier_id === sup.id);
      const supReturns = returns.filter(r => r.supplier_id === sup.id);
      const supPayments = payments.filter(sp => sp.supplier_id === sup.id);

      let totalReceivedCentimes = 0n;
      let totalReturnedCentimes = 0n;
      let totalPaidCentimes = 0n;

      for (const r of supReceipts) totalReceivedCentimes += BigInt(r.total_cost_centimes || 0n);
      for (const ret of supReturns) totalReturnedCentimes += BigInt(ret.total_return_centimes || 0n);
      for (const sp of supPayments) totalPaidCentimes += BigInt(sp.amount_centimes || 0n);

      const netInvoicedCentimes = totalReceivedCentimes - totalReturnedCentimes;
      const outstandingCentimes = netInvoicedCentimes > totalPaidCentimes ? netInvoicedCentimes - totalPaidCentimes : 0n;

      res.push({
        supplierId: sup.id,
        supplierName: sup.name,
        totalInvoicedCentimes,
        totalInvoicedDA: centimesToDinar(totalInvoicedCentimes),
        totalPaidCentimes,
        totalPaidDA: centimesToDinar(totalPaidCentimes),
        outstandingCentimes,
        outstandingDA: centimesToDinar(outstandingCentimes)
      });
    }

    return res;
  }

  /**
   * 13. OPERATING EXPENSES REPORT (Section 24)
   * Posted expenses only; voided expenses recorded separately
   */
  static async getExpenseSummary(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);
    if (filters.actorRole) {
      this.checkReportAccess(filters.actorRole, 'expenses');
    }
    const timeZone = filters.timeZone || DEFAULT_TIMEZONE;
    const { startUtc, endUtc } = resolveDateRangeFilter({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, timeZone });

    const expenses = await tx.query('expenses', e => {
      if (e.tenant_id !== tenantId) return false;
      if (startUtc && e.created_at < startUtc) return false;
      if (endUtc && e.created_at > endUtc) return false;
      if (filters.categoryId && e.category_id !== filters.categoryId) return false;
      return true;
    });

    let activeExpensesCentimes = 0n;
    let voidedExpensesCentimes = 0n;
    const byCategory = {};

    for (const e of expenses) {
      const amt = BigInt(e.amount_centimes || 0n);
      if (e.status === 'POSTED') {
        activeExpensesCentimes += amt;
        const cat = e.category_id || 'OTHER';
        byCategory[cat] = (byCategory[cat] || 0n) + amt;
      } else if (e.status === 'VOIDED') {
        voidedExpensesCentimes += amt;
      }
    }

    return {
      activeExpensesCentimes,
      activeExpensesDA: centimesToDinar(activeExpensesCentimes),
      voidedExpensesCentimes,
      voidedExpensesDA: centimesToDinar(voidedExpensesCentimes),
      byCategory: Object.entries(byCategory).map(([cat, amt]) => ({
        categoryId: cat,
        amountCentimes: amt,
        amountDA: centimesToDinar(amt)
      }))
    };
  }

  /**
   * 14. PROFIT & LOSS REPORT (Section 25)
   * Revenue - COGS = Gross Profit
   * Gross Profit - Operating Expenses = Operating Profit
   */
  static async getProfitSummary(tx, filters = {}) {
    const tenantId = this._enforceTenant(tx, filters);
    if (filters.actorRole) {
      this.checkReportAccess(filters.actorRole, 'profit');
    }

    // Recognized Revenue and COGS from POS sales + Delivered COD orders
    const salesSummary = await this.getSalesSummary(tx, filters);
    const expenseSummary = await this.getExpenseSummary(tx, filters);

    const revenueCentimes = salesSummary.netRevenueCentimes;
    const cogsCentimes = salesSummary.historicalCogsCentimes;
    const grossProfitCentimes = revenueCentimes - cogsCentimes;

    const operatingExpensesCentimes = expenseSummary.activeExpensesCentimes;
    const operatingProfitCentimes = grossProfitCentimes - operatingExpensesCentimes;

    let marginPercent = 'N/A';
    if (revenueCentimes > 0n) {
      marginPercent = `${(Number(grossProfitCentimes * 10000n / revenueCentimes) / 100).toFixed(2)}%`;
    }

    return {
      definitionVersion: METRIC_VERSIONS.PROFIT,
      revenueCentimes,
      revenueDA: centimesToDinar(revenueCentimes),
      cogsCentimes,
      cogsDA: centimesToDinar(cogsCentimes),
      grossProfitCentimes,
      grossProfitDA: centimesToDinar(grossProfitCentimes),
      operatingExpensesCentimes,
      operatingExpensesDA: centimesToDinar(operatingExpensesCentimes),
      operatingProfitCentimes,
      operatingProfitDA: centimesToDinar(operatingProfitCentimes),
      grossMargin: marginPercent
    };
  }

  /**
   * 15. DASHBOARD MAIN KPIS (Section 8 & 9)
   */
  static async getDashboardKPIs(tx, { date = new Date().toISOString().split('T')[0], timeZone = DEFAULT_TIMEZONE } = {}) {
    const tenantId = this._enforceTenant(tx);

    const todayFilter = { dateFrom: date, dateTo: date, timeZone };
    const todayProfit = await this.getProfitSummary(tx, todayFilter);
    const orderFunnel = await this.getOnlineOrderFunnel(tx, todayFilter);
    const lowStock = await this.getLowStockReport(tx);
    const codAnalytics = await this.getCODAnalytics(tx);

    const nowIso = new Date().toISOString();

    return {
      definitionVersion: METRIC_VERSIONS.PROFIT,
      lastUpdatedAt: nowIso,
      period: date,
      todayRevenue: {
        valueCentimes: todayProfit.revenueCentimes,
        valueDA: todayProfit.revenueDA,
        definition: 'Recognized revenue from completed POS sales and delivered orders today'
      },
      todayCogs: {
        valueCentimes: todayProfit.cogsCentimes,
        valueDA: todayProfit.cogsDA,
        definition: 'Historical cost of goods sold from sales today (INV-09-05)'
      },
      todayGrossProfit: {
        valueCentimes: todayProfit.grossProfitCentimes,
        valueDA: todayProfit.grossProfitDA,
        definition: 'Revenue - COGS'
      },
      todayOperatingExpenses: {
        valueCentimes: todayProfit.operatingExpensesCentimes,
        valueDA: todayProfit.operatingExpensesDA,
        definition: 'Active operating expenses posted today'
      },
      todayOperatingProfit: {
        valueCentimes: todayProfit.operatingProfitCentimes,
        valueDA: todayProfit.operatingProfitDA,
        definition: 'Gross Profit - Operating Expenses'
      },
      ordersPendingConfirmation: {
        count: orderFunnel.counts.PENDING_CONFIRMATION,
        definition: 'Inbound online orders awaiting phone confirmation'
      },
      ordersReadyToShip: {
        count: orderFunnel.counts.READY_TO_SHIP,
        definition: 'Confirmed orders packed and awaiting courier pickup'
      },
      shipmentsInTransit: {
        count: orderFunnel.counts.SHIPPED,
        definition: 'Parcels currently in courier transit'
      },
      ordersDelivered: {
        count: orderFunnel.counts.DELIVERED,
        definition: 'Successfully delivered orders'
      },
      ordersReturned: {
        count: orderFunnel.counts.RETURNED,
        definition: 'Orders returned by customer/carrier'
      },
      lowStockVariantsCount: {
        count: lowStock.length,
        definition: 'Variants where available stock is below or at reorder point'
      },
      courierOutstandingSettlement: {
        valueCentimes: codAnalytics.codOutstandingCentimes,
        valueDA: codAnalytics.codOutstandingDA,
        definition: 'COD amount collected or in delivery not yet remitted by couriers'
      }
    };
  }
}

module.exports = {
  ReportingService
};
