const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { ReadModelService } = require('../src/reporting/read_models');
const { ReconciliationService } = require('../src/reporting/reconciliation_service');

test('Phase 13 — Reporting Reconciliation & Fraud Drift Detection (INV-13-17, Requirements 30 & 77)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Rebuilding read models from canonical transactions achieves 0 drift (Requirement 30)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Insert completed sale
      const saleId = generateUUIDv7();
      await tx.insert('sales', {
        id: saleId,
        tenant_id: tenantId,
        status: 'COMPLETED',
        total_centimes: 500000n,
        subtotal_centimes: 500000n,
        cogs_centimes: 250000n,
        created_at: new Date().toISOString()
      });
      await tx.insert('sale_items', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        sale_id: saleId,
        qty: 1,
        total_centimes: 500000n,
        cost_snapshot_centimes: 250000n
      });

      // 2. Rebuild read models from scratch
      const rebuildRes = await ReadModelService.rebuildReadModels(tx);
      assert.strictEqual(rebuildRes.success, true);

      // 3. Reconcile: must be HEALTHY with 0 drift
      const recon = await ReconciliationService.reconcile(tx);
      assert.strictEqual(recon.isHealthy, true);
      assert.strictEqual(recon.status, 'HEALTHY');

      for (const m of recon.metrics) {
        assert.strictEqual(m.status, 'MATCHED', `Metric ${m.metric} should match`);
        assert.strictEqual(m.deltaCentimes, 0n);
      }
    });
  });

  await t.test('2. Reporting fraud / manual drift tampering is immediately detected (Requirement 77)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Attacker attempts to tamper with daily_sales_summaries to inflate revenue
      const summaries = await tx.query('daily_sales_summaries', s => s.tenant_id === tenantId);
      if (summaries.length > 0) {
        await tx.update('daily_sales_summaries', summaries[0].id, {
          net_revenue_centimes: 9999999n // Inflated
        });
      }

      // Reconciliation detects discrepancy
      const recon = await ReconciliationService.reconcile(tx);
      assert.strictEqual(recon.isHealthy, false);
      assert.strictEqual(recon.status, 'REPORTING_DRIFT');

      const revMetric = recon.metrics.find(m => m.metric === 'Revenue');
      assert.strictEqual(revMetric.status, 'DRIFT');
    });
  });
});
