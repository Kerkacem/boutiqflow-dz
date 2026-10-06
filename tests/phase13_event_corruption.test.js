const test = require('node:test');
const assert = require('node:assert');
const { DeadLetterQueueService } = require('../src/security');

test('Phase 13 — Event & Queue Corruption Quarantine Suite (INV-13-10, Requirements 26 & 55)', async (t) => {
  const dlq = new DeadLetterQueueService();

  await t.test('1. Malformed or corrupted event is quarantined without silent drop (INV-13-10)', async () => {
    const corruptPayload = {
      eventId: 'EVT-CORRUPT-001',
      rawBody: 'Malformed JSON { unclosed bracket',
      headers: { 'x-signature': 'INVALID_SIGNATURE' }
    };

    // Quarantine event
    const quarantined = await dlq.quarantineEvent(null, {
      queueName: 'CARRIER_WEBHOOKS',
      originalEventId: 'EVT-CORRUPT-001',
      payload: corruptPayload,
      errorReason: 'SIGNATURE_INVALID_OR_MALFORMED_JSON',
      attemptHistory: [{ timestamp: new Date().toISOString(), error: 'JSON Parse Error' }],
      replayEligible: true
    });

    assert.ok(quarantined.id);
    assert.strictEqual(quarantined.status, 'QUARANTINED');
    assert.strictEqual(quarantined.error_reason, 'SIGNATURE_INVALID_OR_MALFORMED_JSON');

    // Verify it is listed in DLQ
    const list = dlq.listQuarantined({ queueName: 'CARRIER_WEBHOOKS' });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, quarantined.id);
  });

  await t.test('2. Replaying quarantined event after fix resolves status', async () => {
    const item = dlq.listQuarantined()[0];

    // Mock processor that successfully processes the fixed payload
    const mockProcessor = async (payload) => {
      return { orderProcessed: true, parcelTracking: 'YAL-2026-999' };
    };

    const replayRes = await dlq.replayEvent(null, item.id, mockProcessor);
    assert.strictEqual(replayRes.success, true);

    // Verify event is now RESOLVED and no longer active in quarantine
    const activeList = dlq.listQuarantined();
    assert.strictEqual(activeList.length, 0);
  });
});
