const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  TenantLifecycleService,
  TENANT_LIFECYCLE_STATES,
  DELETION_BLOCKERS,
  BILLING_ERRORS
} = require('../src/billing');

test('Phase 12 — Deletion Guards & Legal Hold Integration (INV-12-17, Critical Test 64)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Critical Test 64: Active Legal Hold strictly blocks tenant deletion (INV-12-17)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Place active legal hold on tenant
      await tx.insert('legal_holds', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        title: 'Tax & Commercial Audit 2026',
        reason: 'Statutory compliance audit',
        status: 'ACTIVE',
        scope: 'ALL',
        placed_by: 'LEGAL_OFFICER',
        placed_at: new Date().toISOString()
      });

      // Attempt tenant deletion
      await assert.rejects(
        async () => TenantLifecycleService.requestTenantDeletion(tx, {
          tenantId,
          reason: 'User requested account termination'
        }),
        (err) => {
          assert.strictEqual(err.code, BILLING_ERRORS.DELETION_BLOCKED);
          assert.strictEqual(err.blocker, DELETION_BLOCKERS.LEGAL_HOLD_ACTIVE);
          return true;
        }
      );
    });
  });

  await t.test('2. Open personal data breach strictly blocks tenant deletion (INV-12-17)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Release legal hold
      const holds = await tx.query('legal_holds', h => h.tenant_id === tenantId);
      for (const h of holds) {
        await tx.update('legal_holds', h.id, { status: 'RELEASED' });
      }

      // Record open data breach
      await tx.insert('breach_register', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        title: 'Unauthorized Export Investigation',
        severity: 'HIGH',
        is_resolved: false,
        created_at: new Date().toISOString()
      });

      // Attempt tenant deletion
      await assert.rejects(
        async () => TenantLifecycleService.requestTenantDeletion(tx, {
          tenantId,
          reason: 'User requested account termination'
        }),
        (err) => {
          assert.strictEqual(err.code, BILLING_ERRORS.DELETION_BLOCKED);
          assert.strictEqual(err.blocker, DELETION_BLOCKERS.OPEN_BREACH);
          return true;
        }
      );
    });
  });

  await t.test('3. Clean tenant successfully schedules for deletion review (INV-12-17)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Resolve breach
      const breaches = await tx.query('breach_register', b => b.tenant_id === tenantId);
      for (const b of breaches) {
        await tx.update('breach_register', b.id, { is_resolved: true });
      }

      // Deletion request proceeds to DELETION_PENDING
      const res = await TenantLifecycleService.requestTenantDeletion(tx, {
        tenantId,
        reason: 'Customer voluntary cancellation'
      });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.status, TENANT_LIFECYCLE_STATES.DELETION_PENDING);

      const state = await TenantLifecycleService.getLifecycleState(tx, tenantId);
      assert.strictEqual(state, TENANT_LIFECYCLE_STATES.DELETION_PENDING);
    });
  });
});
