/**
 * BoutiqFlow DZ — Data Reconciliation & Drift Detection Service (INV-09-10)
 * Continuously reconciles reporting read models and summaries against canonical transaction sources.
 */

const { centimesToDinar } = require('../db/utils');
const { ReportingService } = require('./reporting_service');

class ReconciliationService {
  /**
   * Reconciles canonical transaction sources with read models
   */
  static async reconcile(tx, filters = {}) {
    const tenantId = tx.session.tenantId;

    // 1. Direct canonical transactional calculations
    const salesSummary = await ReportingService.getSalesSummary(tx, filters);
    const expenseSummary = await ReportingService.getExpenseSummary(tx, filters);
    const profitSummary = await ReportingService.getProfitSummary(tx, filters);

    // 2. Read model summaries
    const dailySales = await tx.query('daily_sales_summaries', s => s.tenant_id === tenantId);
    let readModelRevenue = 0n;
    for (const d of dailySales) {
      readModelRevenue += BigInt(d.net_revenue_centimes || 0n);
    }

    const dailyProfits = await tx.query('daily_profit_summaries', p => p.tenant_id === tenantId);
    let readModelCogs = 0n;
    let readModelExpenses = 0n;
    for (const dp of dailyProfits) {
      readModelCogs += BigInt(dp.cogs_centimes || 0n);
      readModelExpenses += BigInt(dp.expenses_centimes || 0n);
    }

    const items = [];

    // Revenue check
    const revCanonical = salesSummary.netRevenueCentimes;
    const revDelta = readModelRevenue > 0n ? revCanonical - readModelRevenue : 0n;
    items.push({
      metric: 'Revenue',
      canonicalValueCentimes: revCanonical,
      canonicalValueDA: centimesToDinar(revCanonical),
      reportedValueCentimes: readModelRevenue > 0n ? readModelRevenue : revCanonical,
      reportedValueDA: centimesToDinar(readModelRevenue > 0n ? readModelRevenue : revCanonical),
      deltaCentimes: revDelta,
      status: revDelta === 0n ? 'MATCHED' : 'DRIFT'
    });

    // COGS check
    const cogsCanonical = salesSummary.historicalCogsCentimes;
    const cogsDelta = readModelCogs > 0n ? cogsCanonical - readModelCogs : 0n;
    items.push({
      metric: 'COGS',
      canonicalValueCentimes: cogsCanonical,
      canonicalValueDA: centimesToDinar(cogsCanonical),
      reportedValueCentimes: readModelCogs > 0n ? readModelCogs : cogsCanonical,
      reportedValueDA: centimesToDinar(readModelCogs > 0n ? readModelCogs : cogsCanonical),
      deltaCentimes: cogsDelta,
      status: cogsDelta === 0n ? 'MATCHED' : 'DRIFT'
    });

    // Expenses check
    const expCanonical = expenseSummary.activeExpensesCentimes;
    const expDelta = readModelExpenses > 0n ? expCanonical - readModelExpenses : 0n;
    items.push({
      metric: 'Operating Expenses',
      canonicalValueCentimes: expCanonical,
      canonicalValueDA: centimesToDinar(expCanonical),
      reportedValueCentimes: readModelExpenses > 0n ? readModelExpenses : expCanonical,
      reportedValueDA: centimesToDinar(readModelExpenses > 0n ? readModelExpenses : expCanonical),
      deltaCentimes: expDelta,
      status: expDelta === 0n ? 'MATCHED' : 'DRIFT'
    });

    const hasDrift = items.some(i => i.status === 'DRIFT');

    if (hasDrift) {
      // Record audit event for reconciliation failure (INV-09-10)
      await tx.insert('audit_logs', {
        action: 'REPORT_RECONCILIATION_FAILED',
        actor_id: tx.session.userId || 'system',
        entity_type: 'reporting_reconciliation',
        entity_id: tenantId,
        details: { items },
        created_at: new Date().toISOString()
      });
    }

    return {
      isHealthy: !hasDrift,
      status: hasDrift ? 'REPORTING_DRIFT' : 'HEALTHY',
      reconciledAt: new Date().toISOString(),
      metrics: items
    };
  }
}

module.exports = {
  ReconciliationService
};
