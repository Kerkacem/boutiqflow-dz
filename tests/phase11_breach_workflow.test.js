const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  BreachManagementService,
  SEVERITY_LEVELS
} = require('../src/compliance');

test('Phase 11 — Breach Workflow & Notification Requirements (INV-11-13, INV-11-14, INV-11-17, Section 61, 62)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Processor Breach: BoutiqFlow Processor notifies Controller immediately (INV-11-14, Section 61)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const breach = await BreachManagementService.recordBreach(tx, {
        title: 'Cloud Database Read Replica Exposure',
        severity: SEVERITY_LEVELS.HIGH,
        compromisedDataCategories: ['CUSTOMER_PHONE', 'DELIVERY_ADDRESS'],
        estimatedAffectedCount: 150,
        rootCause: 'Misconfigured cloud firewall rule during maintenance'
      });

      assert.ok(breach.id);
      // Processor to Controller must be immediate upon awareness (INV-11-14)
      assert.ok(breach.notified_merchant_at !== null);
      const diffMs = Math.abs(new Date(breach.notified_merchant_at).getTime() - new Date(breach.created_at).getTime());
      assert.ok(diffMs < 5000, 'Controller notification must be immediate');
    });
  });

  await t.test('2. High-Risk Breach: Triggers plain-language bilingual subject notification workflow (INV-11-17, Section 62)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const highRiskBreach = await BreachManagementService.recordBreach(tx, {
        title: 'SMS Delivery Gateway Credential Leak',
        severity: SEVERITY_LEVELS.HIGH,
        compromisedDataCategories: ['PHONE_NUMBER', 'FULL_NAME', 'ADDRESS'],
        estimatedAffectedCount: 800,
        rootCause: 'Compromised third-party SMS token'
      });

      assert.strictEqual(BreachManagementService.requiresDataSubjectNotification(highRiskBreach), true);

      // Plain language, non-alarming bilingual notification draft
      const noticeDraft = BreachManagementService.generateCustomerNotificationText(highRiskBreach, 'Boutique Elegance Alger');
      assert.ok(noticeDraft.ar.includes('18-07') && noticeDraft.ar.includes('25-11'));
      assert.ok(noticeDraft.fr.includes('18-07') && noticeDraft.fr.includes('25-11'));
      assert.strictEqual(noticeDraft.ar.includes('Elegance Alger'), true);

      // Record dispatch
      const updated = await BreachManagementService.recordDataSubjectNotification(tx, highRiskBreach.id, {
        channel: 'SMS',
        recipientCount: 800
      });
      assert.ok(updated.notified_subjects_at);
      assert.strictEqual(updated.subject_notification_count, 800);
    });
  });

  await t.test('3. Incident vs Data Breach Boundary: Non-PII security incident is not escalated to breach (Section 35)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Internal DDoS on static CDN
      const ddosIncident = await BreachManagementService.assessSecurityIncident(tx, {
        incidentTitle: 'Volumetric DDoS on Static Image CDN',
        affectedAssets: ['images.boutiqflow.dz'],
        involvesPersonalData: false
      });

      assert.strictEqual(ddosIncident.isDataBreach, false);
      assert.strictEqual(ddosIncident.breachRecord, null);

      // API Key leak involving customer data
      const piiIncident = await BreachManagementService.assessSecurityIncident(tx, {
        incidentTitle: 'Cashier API Key published on public gist',
        affectedAssets: ['api.boutiqflow.dz/orders'],
        involvesPersonalData: true,
        piiCategories: ['CUSTOMER_PHONE', 'DELIVERY_ADDRESS']
      });

      assert.strictEqual(piiIncident.isDataBreach, true);
      assert.ok(piiIncident.breachRecord);
      assert.strictEqual(piiIncident.breachRecord.severity, SEVERITY_LEVELS.HIGH);
    });
  });
});
