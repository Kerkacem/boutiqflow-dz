const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  DpiAService,
  ProcessingRegisterService,
  PROCESSING_PURPOSES,
  LEGAL_BASES,
  COMPLIANCE_STATUSES,
  SEVERITY_LEVELS
} = require('../src/compliance');

test('Phase 11 — DPIA Domain & Deterministic Risk Scoring (INV-11-10, Sections 25-27)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Deterministic risk calculation formula (Likelihood x Severity)', () => {
    // 1 x 1 = 1 (LOW)
    assert.strictEqual(DpiAService.calculateRiskScore(1, 1).riskLevel, SEVERITY_LEVELS.LOW);
    // 2 x 3 = 6 (MEDIUM)
    assert.strictEqual(DpiAService.calculateRiskScore(2, 3).riskLevel, SEVERITY_LEVELS.MEDIUM);
    // 3 x 3 = 9 (HIGH)
    assert.strictEqual(DpiAService.calculateRiskScore(3, 3).riskLevel, SEVERITY_LEVELS.HIGH);
    // 4 x 4 = 16 (CRITICAL)
    assert.strictEqual(DpiAService.calculateRiskScore(4, 4).riskLevel, SEVERITY_LEVELS.CRITICAL);
  });

  await t.test('2. DPIA Creation, Risk Assessment & Approval unlocks activity (INV-11-10)', async () => {
    let activity = null;
    let dpia = null;

    await db.withTenant({ tenantId }, async (tx) => {
      activity = await ProcessingRegisterService.registerActivity(tx, {
        name: 'Automated Credit Scoring for Store Debt',
        purpose: PROCESSING_PURPOSES.ACCOUNTING,
        legalBasis: LEGAL_BASES.CONTRACT_EXECUTION,
        dpiaRequired: true
      });

      assert.strictEqual(activity.status, COMPLIANCE_STATUSES.IN_PROGRESS);

      dpia = await DpiAService.createDpia(tx, {
        processingActivityId: activity.id,
        title: 'DPIA on Customer Debt Evaluation Algorithm',
        scope: 'IN_STORE_AND_ONLINE',
        risks: [
          {
            title: 'Unfair credit limit refusal',
            likelihood: 3,
            severity: 3,
            mitigation: 'Human-in-the-loop boutique manager review'
          }
        ]
      });

      assert.strictEqual(dpia.status, COMPLIANCE_STATUSES.IN_PROGRESS);
      assert.strictEqual(dpia.risks[0].riskLevel, SEVERITY_LEVELS.HIGH);
      assert.strictEqual(dpia.risks[0].score, 9);

      // Approve DPIA
      const approved = await DpiAService.approveDpia(tx, dpia.id, {
        approverRole: 'DPO',
        reviewNotes: 'Mitigations reviewed and validated.'
      });

      assert.strictEqual(approved.status, COMPLIANCE_STATUSES.APPROVED);

      // Verify activity in register was automatically unlocked to ACTIVE
      const updatedActivity = await tx.findById('processing_register', activity.id);
      assert.strictEqual(updatedActivity.dpia_status, COMPLIANCE_STATUSES.APPROVED);
      assert.strictEqual(updatedActivity.status, COMPLIANCE_STATUSES.ACTIVE);
    });
  });
});
