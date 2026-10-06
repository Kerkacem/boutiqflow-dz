const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { generatePnLReport } = require('../src/finance/finance');
const { IntegrityCheckJob, INTEGRITY_STATUSES } = require('../src/security');

test('Phase 13 — Financial Integrity & Multi-Variable Balance Chaos (INV-13-14, Requirement 29)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Multi-variable financial lifecycle reconciles mathematically to the centime (Requirement 29)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Sale 1: Total = 10,000 DA (1,000,000 centimes), COGS = 6,000 DA (600,000 centimes)
      const sale1Id = generateUUIDv7();
      await tx.insert('sales', {
        id: sale1Id,
        tenant_id: tenantId,
        status: 'COMPLETED',
        total_centimes: 1000000n,
        subtotal_centimes: 1000000n,
        discount_centimes: 0n,
        created_at: new Date().toISOString()
      });
      await tx.insert('sale_items', {
        id: generateUUIDv7(),
        sale_id: sale1Id,
        qty: 1,
        total_centimes: 1000000n,
        cost_snapshot_centimes: 600000n
      });

      // 2. Sale 2: Total = 5,000 DA (500,000 centimes), COGS = 3,000 DA (300,000 centimes)
      const sale2Id = generateUUIDv7();
      await tx.insert('sales', {
        id: sale2Id,
        tenant_id: tenantId,
        status: 'COMPLETED',
        total_centimes: 500000n,
        subtotal_centimes: 500000n,
        discount_centimes: 0n,
        created_at: new Date().toISOString()
      });
      await tx.insert('sale_items', {
        id: generateUUIDv7(),
        sale_id: sale2Id,
        qty: 1,
        total_centimes: 500000n,
        cost_snapshot_centimes: 300000n
      });

      // 3. Operating Expense: Rent = 2,500 DA (250,000 centimes)
      await tx.insert('expenses', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        amount_centimes: 250000n,
        category: 'RENT',
        status: 'POSTED',
        created_at: new Date().toISOString()
      });

      // Calculate P&L report
      const pnl = await generatePnLReport(tx);

      // Revenue: 1,000,000 + 500,000 = 1,500,000
      assert.strictEqual(pnl.grossSales, 1500000n);

      // COGS: 600,000 + 300,000 = 900,000
      assert.strictEqual(pnl.cogs, 900000n);

      // Gross Profit = Revenue - COGS = 600,000
      assert.strictEqual(pnl.grossProfit, 600000n);

      // Operating Expenses = 250,000
      assert.strictEqual(pnl.totalExpenses, 250000n);

      // Operating Profit = Gross Profit - Operating Expenses = 350,000
      assert.strictEqual(pnl.operatingProfit, 350000n);
    });
  });

  await t.test('2. Sales and Payments integrity verification passes cleanly', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const salesAudit = await IntegrityCheckJob.verifySalesAndPayments(tx, tenantId);
      assert.strictEqual(salesAudit.status, INTEGRITY_STATUSES.MATCHED);
      assert.strictEqual(salesAudit.driftsCount, 0);
    });
  });
});
