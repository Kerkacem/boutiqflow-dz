const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { ReadModelService, REPORTING_EVENTS } = require('../src/reporting');

test('Phase 09 — Reporting Event Ingestion & Idempotency Suite (INV-09-07, Sections 31 & 32)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('INV-09-07: Replaying identical eventId 10 times produces exactly 1 effect and zero duplicate revenue', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const eventId = `evt_sale_${generateUUIDv7()}`;
      const payload = {
        saleId: 'sale_123',
        totalCentimes: 600000n, // 6,000 DA
        units: 2
      };

      // 1. Initial event ingestion
      const firstIngest = await ReadModelService.ingestReportingEvent(tx, {
        eventId,
        eventType: REPORTING_EVENTS.SALE_RECOGNIZED,
        timestamp: '2026-10-06T12:00:00.000Z',
        payload
      });

      assert.strictEqual(firstIngest.replayed, false);
      assert.ok(firstIngest.event.id);

      // Verify read model updated
      const summaries1 = await tx.query('daily_sales_summaries', s => s.tenant_id === tenantId);
      assert.strictEqual(summaries1.length, 1);
      assert.strictEqual(summaries1[0].transactions_count, 1);
      assert.strictEqual(summaries1[0].units_sold, 2);
      assert.strictEqual(summaries1[0].net_revenue_centimes, 600000n);

      // 2. Replay identical event 10 times consecutively (network duplicates / retries)
      for (let i = 0; i < 10; i++) {
        const replay = await ReadModelService.ingestReportingEvent(tx, {
          eventId,
          eventType: REPORTING_EVENTS.SALE_RECOGNIZED,
          timestamp: '2026-10-06T12:00:00.000Z',
          payload
        });
        assert.strictEqual(replay.replayed, true, `Attempt ${i + 1} must be recognized as replayed`);
      }

      // 3. Verify ZERO DUPLICATE EFFECTS in read models:
      const summariesAfter = await tx.query('daily_sales_summaries', s => s.tenant_id === tenantId);
      assert.strictEqual(summariesAfter.length, 1, 'Still exactly 1 summary record');
      assert.strictEqual(summariesAfter[0].transactions_count, 1, 'Transactions count strictly unmutated');
      assert.strictEqual(summariesAfter[0].units_sold, 2, 'Units sold strictly unmutated');
      assert.strictEqual(summariesAfter[0].net_revenue_centimes, 600000n, 'Revenue strictly unmutated (INV-09-07)');

      // 4. Verify append-only log has exactly 1 entry
      const logEntries = await tx.query('reporting_events_log', e => e.tenant_id === tenantId && e.event_id === eventId);
      assert.strictEqual(logEntries.length, 1, 'Exactly 1 entry in reporting_events_log');
    });
  });
});
