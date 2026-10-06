const test = require('node:test');
const assert = require('node:assert');
const {
  validateFieldPrivacyMetadata,
  runCiScan
} = require('../scripts/privacy_ci_gate');
const { FIELD_CLASSIFICATIONS } = require('../src/compliance/constants');

test('Phase 11 — Privacy CI Gate & PII Metadata Enforcement (INV-11-25, Section 55)', async (t) => {
  await t.test('1. Baseline codebase scan passes with zero unclassified fields', () => {
    const passed = runCiScan();
    assert.strictEqual(passed, true);
  });

  await t.test('2. New PII field missing required metadata fails CI validation (INV-11-25)', () => {
    // Simulated new personal field without purpose, retention, or access policy
    const invalidField = {
      name: 'customer.whatsapp_profile_url',
      classification: FIELD_CLASSIFICATIONS.PERSONAL
      // Missing purpose, retentionDays, allowedRoles, journalRequired
    };

    const res = validateFieldPrivacyMetadata(invalidField);
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('Missing purpose')));
    assert.ok(res.errors.some(e => e.includes('Missing retention policy')));
    assert.ok(res.errors.some(e => e.includes('Missing access policy')));
    assert.ok(res.errors.some(e => e.includes('Missing journal policy')));
  });

  await t.test('3. Properly configured new PII field passes validation', () => {
    const validField = {
      name: 'customer.whatsapp_phone',
      classification: FIELD_CLASSIFICATIONS.PERSONAL,
      purpose: 'DELIVERY_COURIER_COORDINATION',
      retentionDays: 730,
      allowedRoles: ['OWNER', 'MANAGER', 'CONFIRMATION_AGENT'],
      journalRequired: true
    };

    const res = validateFieldPrivacyMetadata(validField);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.errors.length, 0);
  });
});
