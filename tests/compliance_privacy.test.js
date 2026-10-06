const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { ProcessingRegisterService } = require('../src/compliance/processing_register');
const { ProcessingJournalService, PROCESSING_OPERATIONS } = require('../src/compliance/processing_journal');
const { BreachManagementService, SEVERITY_LEVELS } = require('../src/compliance/breach_service');
const { DataMaskingService } = require('../src/compliance/data_masking');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase 11 — Privacy & Compliance (Law 18-07 / Law 25-11 Specifications)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const cashierId = generateUUIDv7();
  const managerId = generateUUIDv7();

  await t.test('Register of Processing Activities (Article 39 bis Law 25-11)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Initialize default retail templates
      const defaults = await ProcessingRegisterService.initializeDefaultActivities(tx);
      assert.strictEqual(defaults.length, 3);
      assert.ok(defaults.some(d => d.name.includes('Cash on Delivery')));

      // 2. Register custom marketing activity
      const customActivity = await ProcessingRegisterService.registerActivity(tx, {
        name: 'VIP Loyalty WhatsApp Broadcasts',
        purpose: 'Direct marketing of seasonal boutique collections to opted-in customers',
        legalBasis: 'CONSENT',
        dataCategories: ['CUSTOMER_NAME', 'PHONE_NUMBER', 'PURCHASE_VOLUME'],
        dataSubjects: ['CUSTOMERS'],
        retentionMonths: 12,
        internationalTransfer: false,
        securityMeasures: ['ROW_LEVEL_SECURITY', 'ROLE_BASED_ACCESS_CONTROL']
      });

      assert.strictEqual(customActivity.legal_basis, 'CONSENT');
      const allActivities = await ProcessingRegisterService.listActivities(tx);
      assert.strictEqual(allActivities.length, 4);
    });
  });

  await t.test('Automated Processing Journal / Carnet Automatisé (Article 41 bis 3 Law 25-11)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Log Consultation of Customer Delivery Record
      const entry1 = await ProcessingJournalService.logOperation(tx, {
        actorId: cashierId,
        actorRole: 'CASHIER',
        operation: PROCESSING_OPERATIONS.CONSULTATION,
        dataSubjectType: 'CUSTOMER',
        dataSubjectId: 'cust_alger_101',
        purpose: 'POS_RECEIPT_LOOKUP',
        ipAddress: '192.168.1.50',
        userAgent: 'BoutiqFlow-POS-Terminal/1.0',
        details: { receiptNumber: 'R1-000101' }
      });

      assert.strictEqual(entry1.operation, 'CONSULTATION');
      assert.strictEqual(entry1.actor_role, 'CASHIER');

      // 2. Log Data Extraction (Courier Handover)
      await ProcessingJournalService.logOperation(tx, {
        actorId: managerId,
        actorRole: 'MANAGER',
        operation: PROCESSING_OPERATIONS.DISCLOSURE,
        dataSubjectType: 'CUSTOMER',
        dataSubjectId: 'cust_alger_101',
        purpose: 'COURIER_DISPATCH_YALIDINE',
        details: { courier: 'YALIDINE', tracking: 'yal-998822' }
      });

      // 3. Query audit trail for customer
      const customerLogs = await ProcessingJournalService.queryJournal(tx, { dataSubjectId: 'cust_alger_101' });
      assert.strictEqual(customerLogs.length, 2);
    });
  });

  await t.test('Incident & Breach Management & 5-Day ANPDP Statutory Window (Article 45 bis 8 Law 25-11)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const now = new Date();

      // 1. Record Security Incident discovered today
      const breach = await BreachManagementService.recordBreach(tx, {
        title: 'Unauthorized Export Attempt by Former Staff',
        discoveredAt: now.toISOString(),
        severity: SEVERITY_LEVELS.HIGH,
        compromisedDataCategories: ['CUSTOMER_PHONE', 'DELIVERY_ADDRESS'],
        estimatedAffectedCount: 45,
        rootCause: 'Leaked cashier API credentials revoked immediately',
        remediationSteps: 'Rotated all active session tokens and enforced IP filtering'
      });

      // Verify exact 5-day ANPDP statutory notification deadline
      const expectedDeadline = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
      assert.strictEqual(breach.anpdp_deadline_at, expectedDeadline);
      assert.ok(breach.notified_merchant_at !== null, 'Processor must notify merchant immediately');

      // 2. High severity requires customer notification
      assert.strictEqual(BreachManagementService.requiresDataSubjectNotification(breach), true);
      const textDraft = BreachManagementService.generateCustomerNotificationText(breach, 'Boutique Mode Oran');
      assert.ok(textDraft.ar.includes('18-07') && textDraft.ar.includes('25-11'));
      assert.ok(textDraft.fr.includes('18-07') && textDraft.fr.includes('25-11'));

      // 3. Document notification to ANPDP within the 5-day deadline
      const updated = await BreachManagementService.recordAnpdpNotification(tx, breach.id);
      assert.strictEqual(updated.is_resolved, true);

      // 4. Test delayed notification enforcing justification statement
      const pastBreach = await BreachManagementService.recordBreach(tx, {
        title: 'Legacy Incident Detected in Archived Log',
        discoveredAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
        severity: SEVERITY_LEVELS.LOW,
        rootCause: 'Historical audit log review'
      });

      // Attempting to notify ANPDP past 5 days without reason throws error
      await assert.rejects(
        async () => { await BreachManagementService.recordAnpdpNotification(tx, pastBreach.id); },
        /mandates stating reasons for delay/
      );

      // Notifying with justification succeeds
      const delayedNotification = await BreachManagementService.recordAnpdpNotification(tx, pastBreach.id, {
        delayedReason: 'Complex digital forensics required 7 days to isolate affected records'
      });
      assert.strictEqual(delayedNotification.delay_justification, 'Complex digital forensics required 7 days to isolate affected records');
    });
  });

  await t.test('Privacy-by-Design: Role-Based Personal Data Masking', () => {
    const rawCustomer = {
      id: 'cust_999',
      name: 'Amine Zerrouki',
      phone: '+213555123456',
      address: '14 Rue Didouche Mourad, Alger',
      credit_balance_centimes: 500000n
    };

    // Cashier view: phone masked, address hidden
    const cashierView = DataMaskingService.sanitizeCustomerForRole(rawCustomer, 'CASHIER');
    assert.strictEqual(cashierView.name, 'Amine Zerrouki');
    assert.strictEqual(cashierView.phone, '+213 555 *** *56');
    assert.ok(cashierView.address.includes('محجوب للكاشير'));

    // Manager view: unmasked
    const managerView = DataMaskingService.sanitizeCustomerForRole(rawCustomer, 'MANAGER');
    assert.strictEqual(managerView.phone, '+213555123456');
    assert.strictEqual(managerView.address, '14 Rue Didouche Mourad, Alger');
  });
});
