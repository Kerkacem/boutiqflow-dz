const test = require('node:test');
const assert = require('node:assert');
const { AUDIT_ACTIONS, logAuditEvent } = require('../src/audit/audit_service');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Append-Only Audit Log Verification', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const userA = generateUUIDv7();

  let auditEntryId = null;

  await t.test('Records security-sensitive audit event within tenant transaction', async () => {
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      const entry = await logAuditEvent(tx, {
        action: AUDIT_ACTIONS.PRICE_CHANGE,
        entityType: 'product_variants',
        entityId: generateUUIDv7(),
        metadata: { old_price: 250000, new_price: 280000, reason: 'Supplier cost increase' }
      });

      assert.ok(entry.id);
      assert.strictEqual(entry.tenant_id, tenantA);
      assert.strictEqual(entry.user_id, userA);
      assert.strictEqual(entry.action, AUDIT_ACTIONS.PRICE_CHANGE);
      auditEntryId = entry.id;

      const results = await tx.query('audit_logs');
      assert.strictEqual(results.length, 1);
    });
  });

  await t.test('Audit log isolation: Tenant B cannot view Tenant A audit records', async () => {
    const tenantB = generateUUIDv7();
    const userB = generateUUIDv7();

    await db.withTenant({ tenantId: tenantB, userId: userB }, async (tx) => {
      const results = await tx.query('audit_logs');
      assert.strictEqual(results.length, 0, 'Tenant B must see 0 audit logs from Tenant A');

      const lookup = await tx.findById('audit_logs', auditEntryId);
      assert.strictEqual(lookup, null, 'Direct lookup of foreign audit record must return null');
    });
  });
});
