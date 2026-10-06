const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { ExportService, ReportSnapshotService } = require('../src/reporting');

test('Phase 09 — Export Security, Large Exports & Snapshots Suite (INV-09-17, INV-09-19, Sections 26 & 36)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('Section 36 & INV-09-17: Export exceeding row budget throws EXPORT_TOO_LARGE', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 10 mock sales
      const sales = Array.from({ length: 10 }, (_, i) => ({
        id: `sale_${i}`,
        receipt_number: `REC-${i}`,
        created_at: new Date().toISOString(),
        total_centimes: 100000n,
        customer_name: 'Client Test',
        customer_phone: '0550123456',
        status: 'COMPLETED'
      }));

      // Bounded check: maxRows = 5 -> Throws EXPORT_TOO_LARGE
      await assert.rejects(
        async () => {
          await ExportService.exportSalesCsv(tx, {
            sales,
            maxRows: 5
          });
        },
        /Export size exceeds maximum allowed rows/
      );

      // Within limit: maxRows = 20 -> Succeeds
      const csv = await ExportService.exportSalesCsv(tx, {
        sales,
        maxRows: 20
      });
      assert.ok(csv.startsWith('ID Vente,N° Reçu'));
      assert.strictEqual(csv.split('\n').length, 11); // Header + 10 rows
    });
  });

  await t.test('Sections 26 & 27, INV-09-19: Report Snapshots are cryptographically hashed and strictly immutable', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const mockReportData = {
        month: '2026-10',
        revenueCentimes: '50000000',
        cogsCentimes: '30000000',
        grossProfitCentimes: '20000000'
      };

      // 1. Create immutable snapshot
      const snapshot = await ReportSnapshotService.createSnapshot(tx, {
        reportType: 'MONTH_END_PROFIT',
        period: '2026-10',
        data: mockReportData,
        generatedBy: 'usr_auditor'
      });

      assert.ok(snapshot.id);
      assert.ok(snapshot.data_hash);
      assert.strictEqual(snapshot.definition_version, 'v1');

      // 2. Fetch and cryptographically verify
      const verified = await ReportSnapshotService.getSnapshot(tx, snapshot.id);
      assert.strictEqual(verified.isCryptographicallyValid, true);

      // 3. Attempting to update snapshot is STRICTLY FORBIDDEN (INV-09-19)
      await assert.rejects(
        async () => {
          await tx.update('report_snapshots', snapshot.id, {
            data: { revenueCentimes: '99999999' }
          });
        },
        /report_snapshots records are strictly immutable/
      );

      // 4. Attempting to delete snapshot is STRICTLY FORBIDDEN (INV-09-19)
      await assert.rejects(
        async () => {
          await tx.delete('report_snapshots', snapshot.id);
        },
        /report_snapshots records cannot be deleted/
      );
    });
  });
});
