const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  BreachManagementService
} = require('../src/compliance');

test('Phase 11 — 5-Day Authority Deadline Calculation & Late Notification Justification (INV-11-15, INV-11-16, Section 60)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Critical Test 60: Controller learns of breach at 2026-10-06 14:00 -> Deadline is exactly +5 calendar days', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const knownAt = '2026-10-06T14:00:00.000Z';
      const breach = await BreachManagementService.recordBreach(tx, {
        title: 'Unauthorized Export of Loyalty Customers',
        discoveredAt: knownAt,
        knownAt,
        rootCause: 'Compromised staff credentials'
      });

      // Law 25-11 Art. 45 bis 8: Exactly 5 calendar days = 5 * 24 * 3600 * 1000 ms
      const expectedDeadline = new Date(new Date(knownAt).getTime() + 5 * 24 * 3600 * 1000).toISOString();
      assert.strictEqual(breach.anpdp_deadline_at, expectedDeadline);
      assert.strictEqual(breach.anpdp_deadline_at, '2026-10-11T14:00:00.000Z');
    });
  });

  await t.test('2. Late Authority Notification: Requires documented delay reason (INV-11-16)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Discovered 10 days ago (past the 5-day statutory window)
      const pastKnownAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
      const pastBreach = await BreachManagementService.recordBreach(tx, {
        title: 'Archived Cold Storage Access Log Anomaly',
        discoveredAt: pastKnownAt,
        knownAt: pastKnownAt,
        rootCause: 'Suspicious IP query against old log archive'
      });

      // Notification without delay reason must throw statutory violation
      await assert.rejects(
        async () => BreachManagementService.recordAnpdpNotification(tx, pastBreach.id),
        /Notification is past the 5-day statutory deadline. Art. 45 bis 8 mandates stating reasons for delay/
      );

      // Notification with documented delay reason succeeds
      const notified = await BreachManagementService.recordAnpdpNotification(tx, pastBreach.id, {
        delayedReason: 'Complex digital forensic analysis required to confirm personal data exfiltration.'
      });

      assert.ok(notified.notified_anpdp_at);
      assert.strictEqual(notified.delay_justification, 'Complex digital forensic analysis required to confirm personal data exfiltration.');
    });
  });
});
