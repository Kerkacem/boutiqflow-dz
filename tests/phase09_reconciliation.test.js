const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { ReportingService, ReconciliationService } = require('../src/reporting');

test('Phase 09 — Reconciliation & Critical COD Scenario Suite (INV-09-10, INV-09-13, Section 50)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('CRITICAL COD SCENARIO (Section 50): Order total 7,400 DA -> Delivered -> Collected 7,400 DA -> Settled 7,000 DA -> Outstanding 400 DA', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Online order: Total 7,400 DA (740,000 centimes)
      const order = await tx.insert('online_orders', {
        total_centimes: 740000n,
        cod_amount_centimes: 740000n,
        status: 'DELIVERED'
      });

      // 2. Delivered shipment with 7,400 DA COD
      const shipment = await tx.insert('shipments', {
        order_id: order.id,
        tracking_number: 'YAL-REC-001',
        provider: 'YALIDINE',
        status: 'DELIVERED',
        cod_amount_centimes: 740000n,
        shipping_fee_at_creation_centimes: 60000n
      });

      // 3. Courier collection: 7,400 DA collected by delivery driver
      await tx.insert('courier_collections', {
        shipment_id: shipment.id,
        amount_collected_centimes: 740000n,
        collection_date: new Date().toISOString()
      });

      // 4. Courier settlement: Courier remits 7,000 DA (deducting 400 DA courier fee / discrepancy)
      await tx.insert('courier_settlements', {
        provider: 'YALIDINE',
        settlement_amount_centimes: 700000n,
        status: 'CONFIRMED'
      });

      // 5. Query COD Analytics:
      const codReport = await ReportingService.getCODAnalytics(tx);
      assert.strictEqual(codReport.codExpectedCentimes, 740000n, 'COD expected must be 7,400 DA');
      assert.strictEqual(codReport.codCollectedCentimes, 740000n, 'COD collected must be 7,400 DA');
      assert.strictEqual(codReport.codSettledCentimes, 700000n, 'COD settled must be 7,000 DA');
      assert.strictEqual(codReport.codOutstandingCentimes, 40000n, 'Outstanding settlement must be 400 DA');
      assert.strictEqual(codReport.codUnderSettledCentimes, 40000n, 'Under-settled amount must be 400 DA');

      // 6. INV-09-13: Physical cash drawer is NOT credited with 7,400 DA
      const cashReport = await ReportingService.getCashSummary(tx);
      assert.strictEqual(cashReport.cashSalesCentimes, 0n, 'Courier COD money does not enter cash drawer automatically');
    });
  });

  await t.test('Section 33 & 34: Reporting Drift Detection (INV-09-10)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Initial healthy state (zero drift)
      const healthyCheck = await ReconciliationService.reconcile(tx);
      assert.strictEqual(healthyCheck.isHealthy, true);
      assert.strictEqual(healthyCheck.status, 'HEALTHY');

      // 2. Artificially inject drift into daily_sales_summaries (simulating corrupted read model)
      await tx.insert('daily_sales_summaries', {
        id: generateUUIDv7(),
        day_key: '2026-10-06',
        transactions_count: 99,
        units_sold: 99,
        net_revenue_centimes: 999999999n // Huge drift
      });

      // 3. Reconcile: must detect drift and fail health check
      const driftCheck = await ReconciliationService.reconcile(tx);
      assert.strictEqual(driftCheck.isHealthy, false);
      assert.strictEqual(driftCheck.status, 'REPORTING_DRIFT');

      const revMetric = driftCheck.metrics.find(m => m.metric === 'Revenue');
      assert.strictEqual(revMetric.status, 'DRIFT');

      // 4. Audit log event recorded
      const audit = await tx.query('audit_logs', a => a.action === 'REPORT_RECONCILIATION_FAILED');
      assert.ok(audit.length > 0, 'Reconciliation failure logged in audit trail (INV-09-10)');
    });
  });
});
