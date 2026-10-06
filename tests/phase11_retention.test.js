const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  RetentionEngine,
  RETENTION_ACTIONS,
  COMPLIANCE_STATUSES
} = require('../src/compliance');

test('Phase 11 — Retention Engine & Policy Configuration (INV-11-08, Section 16, 17)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Configures explicit retention policy with legalReviewStatus (INV-11-08)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const policy = await RetentionEngine.createPolicy(tx, {
        dataCategory: 'CONTACT',
        retentionDays: 365,
        actionAfterRetention: RETENTION_ACTIONS.ANONYMIZE,
        legalReviewStatus: COMPLIANCE_STATUSES.LEGAL_REVIEW_REQUIRED
      });

      assert.ok(policy.id);
      assert.strictEqual(policy.retention_days, 365);
      assert.strictEqual(policy.action_after_retention, RETENTION_ACTIONS.ANONYMIZE);
      assert.strictEqual(policy.legal_review_status, COMPLIANCE_STATUSES.LEGAL_REVIEW_REQUIRED);
    });
  });

  await t.test('2. Retention execution job anonymizes eligible expired customer data', async () => {
    let customerId = null;

    await db.withTenant({ tenantId }, async (tx) => {
      const cust = await tx.insert('customers', {
        name: 'Yacine Brahimi',
        phone: '0555998877',
        address: 'Rue Didouche, Alger',
        retention_expired: true // Stored in database table
      });
      customerId = cust.id;

      const report = await RetentionEngine.runRetentionJob(tx);
      assert.strictEqual(report.status, 'COMPLETED');
      assert.strictEqual(report.processedCount, 1);

      // Verify customer anonymized
      const updated = await tx.findById('customers', customerId);
      assert.strictEqual(updated.name, 'Client Anonymisé');
      assert.strictEqual(updated.address, 'Adresse Effacée');
    });
  });
});
