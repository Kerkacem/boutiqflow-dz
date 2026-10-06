const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  ProcessingRegisterService,
  PROCESSING_PURPOSES,
  LEGAL_BASES,
  COMPLIANCE_STATUSES,
  COMPLIANCE_ERRORS
} = require('../src/compliance');

test('Phase 11 — Processing Register & DPIA Gate (INV-11-01, INV-11-02, INV-11-03, INV-11-04, INV-11-10)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Every activity requires explicit name, purpose, and legalBasis (INV-11-01, INV-11-02)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Missing purpose
      await assert.rejects(
        async () => ProcessingRegisterService.registerActivity(tx, {
          name: 'Invalid Activity',
          legalBasis: LEGAL_BASES.CONTRACT_EXECUTION
        }),
        /Processing activity requires name, purpose, and legalBasis/
      );

      // Valid activity registration
      const activity = await ProcessingRegisterService.registerActivity(tx, {
        name: 'POS In-Store Sales & Receipting',
        purpose: PROCESSING_PURPOSES.POS_SALES,
        legalBasis: LEGAL_BASES.CONTRACT_EXECUTION,
        controller: 'MERCHANT_BOUTIQUE',
        processor: 'BOUTIQFLOW_PLATFORM',
        retentionMonths: 36
      });

      assert.ok(activity.id);
      assert.strictEqual(activity.purpose, PROCESSING_PURPOSES.POS_SALES);
      assert.strictEqual(activity.status, COMPLIANCE_STATUSES.ACTIVE);
      assert.strictEqual(activity.controller, 'MERCHANT_BOUTIQUE');
      assert.strictEqual(activity.processor, 'BOUTIQFLOW_PLATFORM');
    });
  });

  await t.test('2. DPIA Gate: Activity requiring DPIA cannot become ACTIVE without APPROVED DPIA (INV-11-10)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Activity with dpiaRequired = true attempting ACTIVE status immediately is rejected
      await assert.rejects(
        async () => ProcessingRegisterService.registerActivity(tx, {
          name: 'AI Facial Profiling for Boutique VIPs',
          purpose: PROCESSING_PURPOSES.MARKETING,
          legalBasis: LEGAL_BASES.CONSENT,
          dpiaRequired: true,
          status: COMPLIANCE_STATUSES.ACTIVE // Forbidden without approved DPIA
        }),
        err => {
          assert.strictEqual(err.code, COMPLIANCE_ERRORS.DPIA_REQUIRED_NOT_APPROVED);
          return true;
        }
      );

      // Registering properly starts in IN_PROGRESS
      const highRiskActivity = await ProcessingRegisterService.registerActivity(tx, {
        name: 'AI Facial Profiling for Boutique VIPs',
        purpose: PROCESSING_PURPOSES.MARKETING,
        legalBasis: LEGAL_BASES.CONSENT,
        dpiaRequired: true
      });

      assert.strictEqual(highRiskActivity.status, COMPLIANCE_STATUSES.IN_PROGRESS);
      assert.strictEqual(highRiskActivity.dpia_status, COMPLIANCE_STATUSES.REQUIRED);

      // Attempting to activate without DPIA approval is blocked
      await assert.rejects(
        async () => ProcessingRegisterService.updateActivityStatus(tx, highRiskActivity.id, {
          targetStatus: COMPLIANCE_STATUSES.ACTIVE
        }),
        err => {
          assert.strictEqual(err.code, COMPLIANCE_ERRORS.DPIA_REQUIRED_NOT_APPROVED);
          return true;
        }
      );

      // Activating with approved DPIA succeeds
      const activated = await ProcessingRegisterService.updateActivityStatus(tx, highRiskActivity.id, {
        targetStatus: COMPLIANCE_STATUSES.ACTIVE,
        dpiaStatus: COMPLIANCE_STATUSES.APPROVED
      });

      assert.strictEqual(activated.status, COMPLIANCE_STATUSES.ACTIVE);
      assert.strictEqual(activated.dpia_status, COMPLIANCE_STATUSES.APPROVED);
    });
  });
});
