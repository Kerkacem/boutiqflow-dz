const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { ROLES } = require('../src/rbac/permissions');
const { ReportingService, ExportService } = require('../src/reporting');

test('Phase 09 — RBAC Report Access Boundaries Suite (Section 37)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('Owner and Manager roles can access all reporting endpoints', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Owner
      const profitOwner = await ReportingService.getProfitSummary(tx, { actorRole: ROLES.OWNER });
      assert.ok(profitOwner);

      const supOwner = await ReportingService.getSupplierSummary(tx, { actorRole: ROLES.OWNER });
      assert.ok(supOwner);

      // Manager
      const profitManager = await ReportingService.getProfitSummary(tx, { actorRole: ROLES.MANAGER });
      assert.ok(profitManager);

      const supManager = await ReportingService.getSupplierSummary(tx, { actorRole: ROLES.MANAGER });
      assert.ok(supManager);
    });
  });

  await t.test('Accountant role can view financial reports, profit, and supplier payables', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const profitAcc = await ReportingService.getProfitSummary(tx, { actorRole: ROLES.ACCOUNTANT });
      assert.ok(profitAcc);

      const supAcc = await ReportingService.getSupplierSummary(tx, { actorRole: ROLES.ACCOUNTANT });
      assert.ok(supAcc);

      const expAcc = await ReportingService.getExpenseSummary(tx, { actorRole: ROLES.ACCOUNTANT });
      assert.ok(expAcc);
    });
  });

  await t.test('Cashier is strictly denied from profit, expenses, and supplier payables reports', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Cashier attempting to view Profit
      await assert.rejects(
        async () => {
          await ReportingService.getProfitSummary(tx, { actorRole: ROLES.CASHIER });
        },
        /Access Denied: Role 'cashier' is not authorized to view 'profit' reports/
      );

      // 2. Cashier attempting to view Supplier Payables
      await assert.rejects(
        async () => {
          await ReportingService.getSupplierSummary(tx, { actorRole: ROLES.CASHIER });
        },
        /Access Denied: Role 'cashier' is not authorized to view 'suppliers' reports/
      );

      // 3. Cashier attempting to view Expenses
      await assert.rejects(
        async () => {
          await ReportingService.getExpenseSummary(tx, { actorRole: ROLES.CASHIER });
        },
        /Access Denied: Role 'cashier' is not authorized to view 'expenses' reports/
      );

      // 4. Cashier attempting to export sales with unmasked PII
      await assert.rejects(
        async () => {
          await ExportService.exportSalesCsv(tx, {
            sales: [{ id: 's1', total_centimes: 1000n }],
            includePii: true,
            actorRole: ROLES.CASHIER
          });
        },
        /Security Violation: Only Managers and Owners are authorized to export customer PII/
      );
    });
  });
});
