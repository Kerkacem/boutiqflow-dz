const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  PrivacyAccessPolicy,
  COMPLIANCE_ERRORS
} = require('../src/compliance');

test('Phase 11 — Super Admin Privacy Boundary & Support Access (INV-11-20, Section 49, 50)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let customer = null;

  await t.test('Setup: Seed customer in tenant database', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      customer = await tx.insert('customers', {
        name: 'Khadija Benali',
        phone: '+213555998877',
        address: 'Rue Hassiba Ben Bouali, Alger'
      });
    });
  });

  await t.test('1. Super Admin cannot browse tenant customer PII by default (INV-11-20)', () => {
    // Attempting access as SUPER_ADMIN without active support session is BLOCKED
    assert.throws(
      () => PrivacyAccessPolicy.sanitizeCustomer(customer, 'SUPER_ADMIN', false),
      err => {
        assert.strictEqual(err.code, COMPLIANCE_ERRORS.SUPER_ADMIN_PII_ACCESS_DENIED);
        return true;
      }
    );

    assert.throws(
      () => PrivacyAccessPolicy.authorizeFieldAccess({
        field: 'CUSTOMER.phone',
        userRole: 'SUPER_ADMIN',
        isSupportSessionActive: false
      }),
      err => {
        assert.strictEqual(err.code, COMPLIANCE_ERRORS.SUPER_ADMIN_PII_ACCESS_DENIED);
        return true;
      }
    );
  });

  await t.test('2. Super Admin Support Session grants time-bound, purpose-bound, audited access', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const session = await PrivacyAccessPolicy.createSupportSession(tx, {
        tenantId,
        actorId: 'superadmin_salim',
        ticketNumber: 'TICKET-9921',
        purpose: 'Investigate stuck online order delivery sync',
        durationMinutes: 30
      });

      assert.ok(session.id);
      assert.strictEqual(session.ticket_number, 'TICKET-9921');

      // Now with active support session, access is granted
      const sanitized = PrivacyAccessPolicy.sanitizeCustomer(customer, 'SUPER_ADMIN', true);
      assert.strictEqual(sanitized.name, 'Khadija Benali');

      // Verify journal logged JUSTIFIED_SUPPORT_ACCESS
      const journalLogs = await tx.query('processing_journal', j => j.purpose === 'JUSTIFIED_SUPPORT_ACCESS');
      assert.strictEqual(journalLogs.length, 1);
      assert.strictEqual(journalLogs[0].actor_id, 'superadmin_salim');
    });
  });

  await t.test('3. Emergency Break-Glass access is heavily audited and requires detailed justification', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Missing or short justification is rejected
      await assert.rejects(
        async () => PrivacyAccessPolicy.breakGlass(tx, {
          tenantId,
          actorId: 'superadmin_salim',
          reason: 'help'
        }),
        /Break-glass access requires comprehensive detailed justification/
      );

      const emergencySession = await PrivacyAccessPolicy.breakGlass(tx, {
        tenantId,
        actorId: 'superadmin_salim',
        reason: 'Critical database deadlock preventing all boutique POS checkouts in Wilaya Alger'
      });

      assert.ok(emergencySession.id);
      assert.ok(emergencySession.ticket_number.startsWith('EMERGENCY-'));

      // Verify journal logged BREAK_GLASS_ACCESS
      const bgLogs = await tx.query('processing_journal', j => j.purpose === 'BREAK_GLASS_ACCESS');
      assert.strictEqual(bgLogs.length, 1);
    });
  });
});
