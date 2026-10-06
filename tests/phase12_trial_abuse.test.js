const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  PhoneVerificationService,
  AbusePreventionEngine,
  ABUSE_SIGNALS,
  ABUSE_DECISIONS
} = require('../src/billing');

test('Phase 12 — Trial Abuse & Phone Verification (INV-12-10, INV-12-12, INV-12-13)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const phone = '0555123456';

  await t.test('1. Phone verification OTP request, resend cooldown, and verification (INV-12-12)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Request OTP
      const req = await PhoneVerificationService.requestVerification(tx, { phone, tenantId });
      assert.ok(req.verificationId);
      assert.ok(req.debugOtp);

      // Verify db stores hash, not plaintext
      const record = await tx.getById('phone_verifications', req.verificationId);
      assert.strictEqual(record.status, 'PENDING');
      assert.notStrictEqual(record.otp_hash, req.debugOtp);

      // 2. Cooldown check: second request immediately must fail
      await assert.rejects(
        async () => PhoneVerificationService.requestVerification(tx, { phone, tenantId }),
        (err) => {
          assert.strictEqual(err.code, 'RESEND_COOLDOWN_ACTIVE');
          return true;
        }
      );

      // 3. Invalid code increments attempt count
      await assert.rejects(
        async () => PhoneVerificationService.verifyCode(tx, { verificationId: req.verificationId, code: '000000' }),
        (err) => {
          assert.strictEqual(err.code, 'INVALID_CODE');
          return true;
        }
      );

      const afterBadAttempt = await tx.getById('phone_verifications', req.verificationId);
      assert.strictEqual(afterBadAttempt.attempts_count, 1);

      // 4. Correct code verifies successfully and destroys hash
      const verifyRes = await PhoneVerificationService.verifyCode(tx, { verificationId: req.verificationId, code: req.debugOtp });
      assert.strictEqual(verifyRes.verified, true);

      const afterSuccess = await tx.getById('phone_verifications', req.verificationId);
      assert.strictEqual(afterSuccess.status, 'VERIFIED');
      assert.strictEqual(afterSuccess.otp_hash, null);
    });
  });

  await t.test('2. Abuse prevention decision engine: single signal != ban (INV-12-13)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Single signal: should ALLOW or LIMIT, never unilaterally BAN
      const res1 = await AbusePreventionEngine.recordAndEvaluateSignal(tx, {
        tenantId,
        signalType: ABUSE_SIGNALS.SIGNUP_VELOCITY,
        confidence: 'LOW',
        metadata: { ip: '105.100.1.1' }
      });
      assert.strictEqual(res1.decision, ABUSE_DECISIONS.ALLOW);

      // Additional signals accumulate
      await AbusePreventionEngine.recordAndEvaluateSignal(tx, {
        tenantId,
        signalType: ABUSE_SIGNALS.TRIAL_REUSE,
        confidence: 'MEDIUM'
      });
      const res3 = await AbusePreventionEngine.recordAndEvaluateSignal(tx, {
        tenantId,
        signalType: ABUSE_SIGNALS.DEVICE_REUSE,
        confidence: 'MEDIUM'
      });
      // 3 signals -> CHALLENGE
      assert.strictEqual(res3.decision, ABUSE_DECISIONS.CHALLENGE);

      // Further signals -> REVIEW
      await AbusePreventionEngine.recordAndEvaluateSignal(tx, { tenantId, signalType: ABUSE_SIGNALS.API_ABUSE });
      const res5 = await AbusePreventionEngine.recordAndEvaluateSignal(tx, { tenantId, signalType: ABUSE_SIGNALS.FAILED_PAYMENT_VELOCITY });
      assert.strictEqual(res5.decision, ABUSE_DECISIONS.REVIEW);
    });
  });
});
