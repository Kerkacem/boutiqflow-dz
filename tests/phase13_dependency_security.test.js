const test = require('node:test');
const assert = require('node:assert');
const { PostgresPatchValidator, SECURITY_ERRORS } = require('../src/security');

test('Phase 13 — Dependency Security & PostgreSQL CVE-2026-14666 Validation (INV-13-01, INV-13-03, Requirement 8)', async (t) => {
  await t.test('1. PostgreSQL CVE-2026-14666 RLS caching vulnerability detection', () => {
    // Unpatched versions prior to fix release
    assert.strictEqual(PostgresPatchValidator.isVulnerableToCVE2026_14666('16.14'), true);
    assert.strictEqual(PostgresPatchValidator.isVulnerableToCVE2026_14666('17.10'), true);
    assert.strictEqual(PostgresPatchValidator.isVulnerableToCVE2026_14666('18.5'), true);
    assert.strictEqual(PostgresPatchValidator.isVulnerableToCVE2026_14666('15.18'), true);
    assert.strictEqual(PostgresPatchValidator.isVulnerableToCVE2026_14666('14.23'), true);

    // Patched versions
    assert.strictEqual(PostgresPatchValidator.isVulnerableToCVE2026_14666('16.15'), false);
    assert.strictEqual(PostgresPatchValidator.isVulnerableToCVE2026_14666('17.11'), false);
    assert.strictEqual(PostgresPatchValidator.isVulnerableToCVE2026_14666('18.6'), false);
    assert.strictEqual(PostgresPatchValidator.isVulnerableToCVE2026_14666('15.19'), false);
    assert.strictEqual(PostgresPatchValidator.isVulnerableToCVE2026_14666('14.24'), false);
  });

  await t.test('2. Gate 13 blocks vulnerable database environments without mitigation (INV-13-01)', () => {
    // Vulnerable without mitigation throws DATABASE_VULNERABLE
    assert.throws(
      () => PostgresPatchValidator.validateDatabaseEnvironment('16.14', { hasDocumentedMitigation: false }),
      (err) => {
        assert.strictEqual(err.code, SECURITY_ERRORS.DATABASE_VULNERABLE);
        return true;
      }
    );

    // Patched version passes cleanly
    const safeRes = PostgresPatchValidator.validateDatabaseEnvironment('17.11', { forceRlsEnabled: true });
    assert.strictEqual(safeRes.status, 'VERIFIED_SAFE');
    assert.strictEqual(safeRes.isPatched, true);
  });
});
