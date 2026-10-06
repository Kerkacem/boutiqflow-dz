const test = require('node:test');
const assert = require('node:assert');
const { dinarToCentimes, centimesToDinar, formatDinar, normalizeAlgerianPhone, generateUUIDv7 } = require('../src/db/utils');
const { MahalDatabase } = require('../src/db/client');

test('Core Data Invariants & Utilities', async (t) => {
  await t.test('Money Math: Strict BigInt Centimes with no floating point errors', () => {
    // 1500.50 DA = 150050 centimes
    const centimes1 = dinarToCentimes('1500.50');
    assert.strictEqual(centimes1, 150050n);

    // Summing prices
    const item1 = dinarToCentimes('2500'); // 2500 DA
    const item2 = dinarToCentimes('1450.75'); // 1450.75 DA
    const total = item1 + item2;
    assert.strictEqual(total, 395075n);
    assert.strictEqual(centimesToDinar(total), '3950.75');

    // Formatting in Arabic and French
    assert.ok(formatDinar(total, 'ar-DZ').includes('دج'));
    assert.ok(formatDinar(total, 'fr-DZ').includes('DA'));

    // Rejection of invalid inputs
    assert.throws(() => dinarToCentimes('not_a_number'), /Invalid dinar amount/);
  });

  await t.test('Phone Normalization: Algerian numbers to E.164 (+213)', () => {
    assert.strictEqual(normalizeAlgerianPhone('0550123456'), '+213550123456');
    assert.strictEqual(normalizeAlgerianPhone('0661234567'), '+213661234567');
    assert.strictEqual(normalizeAlgerianPhone('0770987654'), '+213770987654');
    assert.strictEqual(normalizeAlgerianPhone('+213550123456'), '+213550123456');
    assert.strictEqual(normalizeAlgerianPhone('00213550123456'), '+213550123456');
    assert.strictEqual(normalizeAlgerianPhone('05 50 12 34 56'), '+213550123456');
    assert.strictEqual(normalizeAlgerianPhone('05-50-12-34-56'), '+213550123456');
    assert.strictEqual(normalizeAlgerianPhone('123456'), null);
    assert.strictEqual(normalizeAlgerianPhone(''), null);
  });

  await t.test('UUIDv7: Version 7 and Variant 2 specification check', () => {
    const uuid1 = generateUUIDv7(Date.now() - 1000);
    const uuid2 = generateUUIDv7(Date.now());

    // Check version 7 marker (character 14 must be '7')
    assert.strictEqual(uuid1[14], '7', 'UUID must be version 7');
    assert.strictEqual(uuid2[14], '7', 'UUID must be version 7');

    // Check variant marker (character 19 must be 8, 9, a, or b)
    assert.ok(['8', '9', 'a', 'b'].includes(uuid1[19].toLowerCase()), 'UUID must be variant 2');

    // Time-ordered: uuid1 created earlier must be lexicographically smaller than uuid2
    assert.ok(uuid1 < uuid2, 'UUIDv7 must be time-ordered');
  });

  await t.test('INV-3: Idempotency Key Uniqueness per Tenant', async () => {
    const db = new MahalDatabase();
    const tenantA = generateUUIDv7();
    const tenantB = generateUUIDv7();
    const idempotencyKey = 'sale_order_tx_001';

    // Tenant A registers an idempotency key
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const record = await tx.insert('idempotency_keys', {
        key: idempotencyKey,
        status_code: 201
      });
      assert.strictEqual(record.key, idempotencyKey);
    });

    // Tenant B can use the same key without conflict (keys are scoped per tenant)
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const record = await tx.insert('idempotency_keys', {
        key: idempotencyKey,
        status_code: 201
      });
      assert.strictEqual(record.key, idempotencyKey);
    });

    // Tenant A querying idempotency keys sees only their own
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const keys = await tx.query('idempotency_keys');
      assert.strictEqual(keys.length, 1);
      assert.strictEqual(keys[0].tenant_id, tenantA);
    });
  });
});
