const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { ROLES } = require('../src/rbac/permissions');
const { ExportService } = require('../src/reporting');

test('Phase 09 — Customer PII Export Controls & Law 25-11 Journaling Suite (INV-09-16, Section 38)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  const mockSales = [
    {
      id: 'sale_pii_1',
      receipt_number: 'REC-001',
      created_at: new Date().toISOString(),
      total_centimes: 450000n,
      customer_name: 'Amina Mansouri',
      customer_phone: '0550123456',
      items_count: 2,
      status: 'COMPLETED'
    }
  ];

  await t.test('Default export masks customer phone numbers and names', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const csv = await ExportService.exportSalesCsv(tx, {
        sales: mockSales,
        includePii: false
      });

      assert.ok(csv.includes('0550***56'), 'Phone number is masked by default');
      assert.ok(csv.includes('Amin***ri'), 'Customer name is masked by default');
      assert.ok(!csv.includes('0550123456'), 'Plaintext phone does not appear in default export');
    });
  });

  await t.test('INV-09-16: Unauthorized role attempting to export unmasked PII is strictly blocked', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      await assert.rejects(
        async () => {
          await ExportService.exportSalesCsv(tx, {
            sales: mockSales,
            includePii: true,
            actorRole: ROLES.CASHIER
          });
        },
        /Security Violation: Only Managers and Owners are authorized to export customer PII/
      );
    });
  });

  await t.test('Manager/Owner unmasked export automatically writes PERSONAL_DATA_EXPORTED to processing_journal', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const csv = await ExportService.exportSalesCsv(tx, {
        sales: mockSales,
        includePii: true,
        actorRole: ROLES.MANAGER,
        actorId: 'usr_manager_01',
        purpose: 'Auditing courier delivery reconciliations'
      });

      // 1. Phone number is unmasked
      assert.ok(csv.includes('0550123456'), 'Phone number unmasked for authorized manager');
      assert.ok(csv.includes('Amina Mansouri'));

      // 2. Processing Journal automatically logs statutory compliance event (Law 25-11 Art. 41 bis 3)
      const journal = await tx.query('processing_journal', j =>
        j.tenant_id === tenantId && j.action === 'PERSONAL_DATA_EXPORTED'
      );
      assert.strictEqual(journal.length, 1, 'Processing Journal recorded compliance entry');
      assert.strictEqual(journal[0].actor_id, 'usr_manager_01');
      assert.strictEqual(journal[0].purpose, 'Auditing courier delivery reconciliations');
      assert.strictEqual(journal[0].records_count, 1);
    });
  });
});
