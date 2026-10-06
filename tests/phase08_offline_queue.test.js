const test = require('node:test');
const assert = require('node:assert');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  LocalOutbox,
  OFFLINE_OPERATIONS,
  DISALLOWED_OFFLINE_OPERATIONS,
  OUTBOX_STATUSES
} = require('../src/offline');

test('Phase 08 — Local Outbox Queue & Capability Matrix Suite (INV-08-11, INV-08-24)', async (t) => {
  const tenantId = generateUUIDv7();
  const deviceId = 'POS-REG-01';

  const outbox = new LocalOutbox({ deviceId, tenantId });

  await t.test('Allowed Offline Operations enqueue successfully with monotonic sequencing', () => {
    // 1. POS Sale
    const item1 = outbox.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.POS_SALE,
      payload: {
        locationId: 'loc-1',
        cashierId: 'csh-1',
        items: [{ variantId: 'var-1', quantity: 2 }],
        payments: [{ tenderType: 'CASH', amountCentimes: 500000n }]
      }
    });

    assert.strictEqual(item1.sequenceNumber, 1, 'First sequence is 1');
    assert.strictEqual(item1.deviceId, deviceId);
    assert.strictEqual(item1.status, OUTBOX_STATUSES.QUEUED);
    assert.ok(item1.operationId.startsWith('op_'), 'OperationId generated with prefix');
    assert.ok(item1.requestHash, 'Payload hash computed');

    // 2. Payment Record
    const item2 = outbox.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.PAYMENT_RECORD,
      payload: { saleId: 'sale-1', amountCentimes: 100000n }
    });
    assert.strictEqual(item2.sequenceNumber, 2, 'Monotonic sequence incremented to 2');

    // 3. Receipt Generation
    const item3 = outbox.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.RECEIPT_GENERATION,
      payload: { saleId: 'sale-1', registerId: 'reg-1' }
    });
    assert.strictEqual(item3.sequenceNumber, 3, 'Monotonic sequence incremented to 3');

    assert.strictEqual(outbox.getPendingCount(), 3);
  });

  await t.test('INV-08-11 & INV-08-24: Disallowed Offline Operations are strictly rejected at queue boundary', () => {
    const disallowed = Object.values(DISALLOWED_OFFLINE_OPERATIONS);

    for (const opType of disallowed) {
      assert.throws(
        () => {
          outbox.enqueueOperation({
            operationType: opType,
            payload: { name: 'Attempted offline mutation' }
          });
        },
        /Capability Violation: Operation '.*' is strictly prohibited offline/,
        `Disallowed operation ${opType} rejected`
      );
    }

    // Queue count unchanged
    assert.strictEqual(outbox.getPendingCount(), 3);
  });
});
