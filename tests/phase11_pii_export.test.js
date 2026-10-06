const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  ComplianceEvidenceService,
  ProcessingRegisterService,
  COMPLIANCE_ERRORS
} = require('../src/compliance');

test('Phase 11 — PII Export Controls & Auditable Evidence Packages (INV-11-21, INV-11-26)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('Setup: Seed default processing register activities', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      await ProcessingRegisterService.initializeDefaultActivities(tx);
    });
  });

  await t.test('1. Unauthorized role (CASHIER) attempting compliance export is blocked (INV-11-21)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      await assert.rejects(
        async () => ComplianceEvidenceService.generateEvidencePack(tx, {
          actorRole: 'CASHIER',
          generatedBy: 'cashier_user'
        }),
        err => {
          assert.strictEqual(err.code, COMPLIANCE_ERRORS.UNAUTHORIZED_EXPORT);
          return true;
        }
      );
    });
  });

  await t.test('2. Authorized export by OWNER generates cryptographically hashed pack & journals event (INV-11-26)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const pack = await ComplianceEvidenceService.generateEvidencePack(tx, {
        actorRole: 'OWNER',
        generatedBy: 'owner_user'
      });

      assert.ok(pack.exportId);
      assert.strictEqual(pack.definitionVersion, 'v1.0-LAW2511');
      assert.ok(pack.dataHash);
      assert.strictEqual(pack.dataHash.length, 64); // SHA-256
      assert.strictEqual(pack.summary.processingActivitiesCount, 3);

      // Verify immutable compliance_evidence_exports record in database
      const stored = await tx.findById('compliance_evidence_exports', pack.exportId);
      assert.ok(stored);
      assert.strictEqual(stored.data_hash, pack.dataHash);

      // Verify journal entry logged
      const journal = await tx.query('processing_journal', j => j.purpose === 'COMPLIANCE_EVIDENCE_EXPORT');
      assert.strictEqual(journal.length, 1);
    });
  });
});
