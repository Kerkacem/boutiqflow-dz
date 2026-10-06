const test = require('node:test');
const assert = require('node:assert');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  LocalOutbox,
  OFFLINE_OPERATIONS,
  OUTBOX_STATUSES
} = require('../src/offline');

test('Phase 08 — Multi-Tab Safety & Recoverable Lease Suite (INV-08-22)', async (t) => {
  const tenantId = generateUUIDv7();
  const deviceId = 'POS-TAB-TEST';
  const outbox = new LocalOutbox({ deviceId, tenantId });

  // Enqueue 2 offline sales
  outbox.enqueueOperation({
    operationType: OFFLINE_OPERATIONS.POS_SALE,
    payload: { saleNumber: 1, amountCentimes: 100000n }
  });
  outbox.enqueueOperation({
    operationType: OFFLINE_OPERATIONS.POS_SALE,
    payload: { saleNumber: 2, amountCentimes: 200000n }
  });

  assert.strictEqual(outbox.getPendingCount(), 2);

  await t.test('Tab 1 claims batch with short lease (INV-08-22)', () => {
    const claimedByTab1 = outbox.claimBatch({
      ownerId: 'TAB_1',
      leaseDurationMs: 100, // 100ms lease
      limit: 10
    });

    assert.strictEqual(claimedByTab1.length, 2, 'Tab 1 claimed both items');
    assert.strictEqual(claimedByTab1[0].processingOwner, 'TAB_1');
    assert.strictEqual(claimedByTab1[0].status, OUTBOX_STATUSES.SENDING);
  });

  await t.test('Tab 2 attempting to claim concurrently while Tab 1 lease is active receives 0 items', () => {
    const claimedByTab2 = outbox.claimBatch({
      ownerId: 'TAB_2',
      limit: 10
    });

    assert.strictEqual(claimedByTab2.length, 0, 'Tab 2 receives 0 items while Tab 1 lease is active');
  });

  await t.test('Tab 1 crashes; after lease expires, Tab 2 successfully re-claims items (INV-08-22)', async () => {
    // Wait 120ms for Tab 1 lease to expire
    await new Promise(resolve => setTimeout(resolve, 120));

    const reClaimedByTab2 = outbox.claimBatch({
      ownerId: 'TAB_2',
      leaseDurationMs: 5000,
      limit: 10
    });

    assert.strictEqual(reClaimedByTab2.length, 2, 'Tab 2 successfully recovered expired lease');
    assert.strictEqual(reClaimedByTab2[0].processingOwner, 'TAB_2');
    assert.strictEqual(reClaimedByTab2[0].attemptCount, 2, 'Attempt count incremented');

    // Tab 2 successfully acks
    for (const item of reClaimedByTab2) {
      outbox.ackOperation(item.operationId, { serverRef: 'srv_ok' });
    }

    assert.strictEqual(outbox.getPendingCount(), 0, 'All items successfully processed and acknowledged');
  });
});
