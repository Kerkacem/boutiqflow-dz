const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  toTenantDayKey,
  toTenantHour,
  getUtcRangeForLocalDate,
  ReportingService
} = require('../src/reporting');

test('Phase 09 — Tenant Timezone & Business Day Boundary Suite (INV-09-11, Sections 6 & 7)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('Section 7 & INV-09-11: Algiers Timezone (UTC+1) Day Boundary Conversion', async () => {
    // 1. UTC 2026-10-05T23:30:00Z is 00:30 on 2026-10-06 in Africa/Algiers
    const dayKey1 = toTenantDayKey('2026-10-05T23:30:00Z', 'Africa/Algiers');
    assert.strictEqual(dayKey1, '2026-10-06', '23:30 UTC belongs to the NEXT local day in Algiers');

    const hour1 = toTenantHour('2026-10-05T23:30:00Z', 'Africa/Algiers');
    assert.strictEqual(hour1, 0, 'Hour is 00:00 in Algiers');

    // 2. UTC 2026-10-06T23:30:00Z is 00:30 on 2026-10-07 in Africa/Algiers
    const dayKey2 = toTenantDayKey('2026-10-06T23:30:00Z', 'Africa/Algiers');
    assert.strictEqual(dayKey2, '2026-10-07', '23:30 UTC on Oct 6 belongs to Oct 7 in Algiers');

    // 3. getUtcRangeForLocalDate for '2026-10-06' in Africa/Algiers
    const range = getUtcRangeForLocalDate('2026-10-06', 'Africa/Algiers');
    assert.strictEqual(range.startUtc, '2026-10-05T23:00:00.000Z');
    assert.strictEqual(range.endUtc, '2026-10-06T22:59:59.999Z');
  });

  await t.test('Reporting Filter respects local day boundary for daily sales', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Sale 1: Created at 2026-10-05T23:15:00Z (00:15 local Oct 6) -> 5,000 DA
      await tx.insert('sales', {
        id: generateUUIDv7(),
        subtotal_centimes: 500000n,
        total_centimes: 500000n,
        status: 'COMPLETED',
        created_at: '2026-10-05T23:15:00.000Z'
      });

      // Sale 2: Created at 2026-10-06T14:00:00Z (15:00 local Oct 6) -> 3,000 DA
      await tx.insert('sales', {
        id: generateUUIDv7(),
        subtotal_centimes: 300000n,
        total_centimes: 300000n,
        status: 'COMPLETED',
        created_at: '2026-10-06T14:00:00.000Z'
      });

      // Sale 3: Created at 2026-10-06T23:15:00Z (00:15 local Oct 7) -> 8,000 DA
      await tx.insert('sales', {
        id: generateUUIDv7(),
        subtotal_centimes: 800000n,
        total_centimes: 800000n,
        status: 'COMPLETED',
        created_at: '2026-10-06T23:15:00.000Z'
      });

      // Query Sales report strictly for local day '2026-10-06':
      // Must include Sale 1 (5,000 DA) and Sale 2 (3,000 DA) = 8,000 DA total
      // Must strictly exclude Sale 3 (which falls on local day Oct 7)!
      const report = await ReportingService.getSalesSummary(tx, {
        dateFrom: '2026-10-06',
        dateTo: '2026-10-06',
        timeZone: 'Africa/Algiers'
      });

      assert.strictEqual(report.transactionsCount, 2, 'Exactly 2 sales belong to local day Oct 6');
      assert.strictEqual(report.grossSalesCentimes, 800000n, 'Total gross sales is 8,000 DA (5,000 + 3,000)');
    });
  });
});
