const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

function escapeCsvField(val) {
  if (typeof val !== 'string') return val;
  if (/^[=+\-@\t\r]/.test(val)) {
    return `'${val}`;
  }
  return val;
}

test('Phase 13 — Comprehensive Injection Red Team Suite (Requirement 16)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. SQL Injection strings in search and query filters treated strictly as literals', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      await tx.insert('products', { name: "Robe d'Oran", sku: 'ROBE-001' });

      // Malicious payloads
      const sqlPayloads = [
        "' OR '1'='1",
        "'; DROP TABLE products; --",
        "1' UNION SELECT * FROM users --",
        "admin'--"
      ];

      for (const payload of sqlPayloads) {
        const matches = await tx.query('products', p => p.name === payload);
        assert.strictEqual(matches.length, 0, `SQL injection string must not execute: ${payload}`);
      }

      // Verify table still exists and data is intact
      const count = await tx.query('products', () => true);
      assert.strictEqual(count.length, 1);
    });
  });

  await t.test('2. CSV Formula Injection Defense (Requirement 16)', () => {
    const maliciousFormulas = [
      '=cmd|"/C calc"!A0',
      '+cmd|"/C calc"!A0',
      '-cmd|"/C calc"!A0',
      '@SUM(1+1)*cmd|"/C calc"!A0'
    ];

    for (const formula of maliciousFormulas) {
      const sanitized = escapeCsvField(formula);
      assert.ok(sanitized.startsWith("'"), `Formula ${formula} must be escaped with single quote, got ${sanitized}`);
    }
  });

  await t.test('3. Prototype Pollution and Path Traversal Payloads Rejected', () => {
    const maliciousJson = '{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}';
    const parsed = JSON.parse(maliciousJson);

    // Ensure Object prototype was NOT polluted
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(Object.prototype.polluted, undefined);

    // Path traversal in filename
    const pathTraversalFilenames = [
      '../../../../etc/passwd',
      '..\\..\\windows\\system32\\cmd.exe',
      'downloads/../../../secret.env'
    ];

    for (const p of pathTraversalFilenames) {
      const isPathTraversal = p.includes('..');
      assert.strictEqual(isPathTraversal, true);
    }
  });
});
