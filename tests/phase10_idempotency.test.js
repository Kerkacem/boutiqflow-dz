const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  PublicApiService,
  INTEGRATION_ERRORS
} = require('../src/integrations');

test('Phase 10 — Public Mutation Idempotency & Tamper Rejection (INV-10-07, INV-10-18)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const idempotencyKey = 'idem_order_creation_key_123';

  await t.test('1. Same key + same payload returns cached result without re-executing (INV-10-18)', async () => {
    let executionCount = 0;
    const originalPayload = { customerName: 'Samir', total: 5000 };

    const firstRun = await db.withTenant({ tenantId }, async (tx) => {
      return await PublicApiService.handleIdempotency(tx, {
        tenantId,
        idempotencyKey,
        payload: originalPayload,
        executionFn: async () => {
          executionCount++;
          return { orderId: 'ord_1', status: 'CREATED', executionCount };
        }
      });
    });

    assert.strictEqual(firstRun.replayed, false);
    assert.strictEqual(firstRun.result.orderId, 'ord_1');
    assert.strictEqual(executionCount, 1);

    // Second call: exact same key and exact same payload
    const secondRun = await db.withTenant({ tenantId }, async (tx) => {
      return await PublicApiService.handleIdempotency(tx, {
        tenantId,
        idempotencyKey,
        payload: originalPayload,
        executionFn: async () => {
          executionCount++;
          return { orderId: 'ord_2', status: 'CREATED', executionCount };
        }
      });
    });

    assert.strictEqual(secondRun.replayed, true);
    assert.strictEqual(secondRun.result.orderId, 'ord_1');
    assert.strictEqual(executionCount, 1, 'ExecutionFn must NOT have been called again');
  });

  await t.test('2. Same key + different payload throws 409 IDEMPOTENCY_KEY_REUSE (INV-10-07)', async () => {
    const tamperedPayload = { customerName: 'Samir', total: 999999 }; // altered payload

    await db.withTenant({ tenantId }, async (tx) => {
      await assert.rejects(
        async () => PublicApiService.handleIdempotency(tx, {
          tenantId,
          idempotencyKey,
          payload: tamperedPayload,
          executionFn: async () => ({ orderId: 'ord_3' })
        }),
        err => {
          assert.strictEqual(err.code, INTEGRATION_ERRORS.IDEMPOTENCY_KEY_REUSE);
          assert.strictEqual(err.statusCode, 409);
          return true;
        }
      );
    });
  });
});
