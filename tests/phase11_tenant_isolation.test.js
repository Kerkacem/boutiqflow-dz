const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  ProcessingRegisterService,
  ProcessingJournalService,
  BreachManagementService,
  PrivacyRequestService,
  PROCESSING_OPERATIONS,
  PRIVACY_REQUEST_TYPES
} = require('../src/compliance');

test('Phase 11 — Tenant Isolation across All Compliance Subsystems (INV-11-04, INV-11-27, Section 66)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let journalAId = null;
  let breachAId = null;
  let requestAId = null;

  await t.test('Setup: Seed Tenant A and Tenant B compliance entities', async () => {
    // Tenant A
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await ProcessingRegisterService.initializeDefaultActivities(tx);

      const entryA = await ProcessingJournalService.logOperation(tx, {
        actorId: 'user_a',
        operation: PROCESSING_OPERATIONS.VIEWED,
        purpose: 'TENANT_A_INTERNAL_OP'
      });
      journalAId = entryA.id;

      const breachA = await BreachManagementService.recordBreach(tx, {
        title: 'Tenant A Minor Incident',
        rootCause: 'Tenant A internal test'
      });
      breachAId = breachA.id;

      const reqA = await PrivacyRequestService.createRequest(tx, {
        identifier: '0555000001',
        type: PRIVACY_REQUEST_TYPES.ACCESS
      });
      requestAId = reqA.id;
    });

    // Tenant B
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      await ProcessingRegisterService.initializeDefaultActivities(tx);
    });
  });

  await t.test('1. Tenant B cannot see Tenant A activities, journal, breaches, or privacy requests (INV-11-27)', async () => {
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      // 1. Direct lookup of Tenant A journal entry returns null
      const journalEntry = await tx.findById('processing_journal', journalAId);
      assert.strictEqual(journalEntry, null, 'Tenant B must not access Tenant A processing journal');

      // 2. Direct lookup of Tenant A breach returns null
      const breach = await tx.findById('breach_register', breachAId);
      assert.strictEqual(breach, null, 'Tenant B must not access Tenant A breach record');

      // 3. Direct lookup of Tenant A privacy request returns null
      const request = await tx.findById('privacy_requests', requestAId);
      assert.strictEqual(request, null, 'Tenant B must not access Tenant A privacy request');

      // 4. Querying journal in Tenant B returns only Tenant B entries (0)
      const bJournal = await ProcessingJournalService.queryJournal(tx);
      assert.strictEqual(bJournal.length, 0);

      // 5. Querying activities returns only Tenant B activities (3)
      const bActivities = await ProcessingRegisterService.listActivities(tx);
      assert.strictEqual(bActivities.length, 3);
      assert.ok(bActivities.every(a => a.tenant_id === tenantB));
    });
  });
});
