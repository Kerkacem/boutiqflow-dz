const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { ReportingService } = require('../src/reporting');

test('Phase 09 — Dashboard KPIs, Zero-Denominator Safety & Performance Suite (INV-09-12, Sections 8, 9, 39)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('Section 39: Dashboard KPIs query responds well within performance budget (< 250ms)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const start = Date.now();
      const kpis = await ReportingService.getDashboardKPIs(tx, { date: '2026-10-06' });
      const durationMs = Date.now() - start;

      assert.ok(durationMs < 250, `Dashboard query took ${durationMs}ms, well within 250ms budget`);
      assert.ok(kpis.todayRevenue);
      assert.ok(kpis.todayCogs);
      assert.ok(kpis.todayGrossProfit);
      assert.ok(kpis.todayOperatingExpenses);
      assert.ok(kpis.todayOperatingProfit);
      assert.ok(kpis.ordersPendingConfirmation);
      assert.ok(kpis.shipmentsInTransit);
      assert.ok(kpis.lowStockVariantsCount);
      assert.ok(kpis.courierOutstandingSettlement);
    });
  });

  await t.test('INV-09-12 & Section 12: Zero Revenue produces margin N/A, never misleading 0% or NaN', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Empty day with 0 sales
      const profit = await ReportingService.getProfitSummary(tx, { dateFrom: '2026-01-01', dateTo: '2026-01-01' });

      assert.strictEqual(profit.revenueCentimes, 0n);
      assert.strictEqual(profit.grossMargin, 'N/A', 'Margin must be N/A when revenue is zero (INV-09-12)');

      const byProduct = await ReportingService.getSalesByProduct(tx, { dateFrom: '2026-01-01', dateTo: '2026-01-01' });
      assert.strictEqual(byProduct.length, 0);
    });
  });

  await t.test('Section 9 & INV-09-12: Zero previous denominator produces "New" or "0%", never +Infinity%', async () => {
    // 1. Previous = 0, Current = 1000 -> "New"
    const pct1 = ReportingService._calculatePercentageChange(1000n, 0n);
    assert.strictEqual(pct1, 'New');

    // 2. Previous = 0, Current = 0 -> "0%"
    const pct2 = ReportingService._calculatePercentageChange(0n, 0n);
    assert.strictEqual(pct2, '0%');

    // 3. Previous = 100, Current = 150 -> "+50.0%"
    const pct3 = ReportingService._calculatePercentageChange(150n, 100n);
    assert.strictEqual(pct3, '+50.0%');

    // 4. Previous = 100, Current = 80 -> "-20.0%"
    const pct4 = ReportingService._calculatePercentageChange(80n, 100n);
    assert.strictEqual(pct4, '-20.0%');
  });
});
