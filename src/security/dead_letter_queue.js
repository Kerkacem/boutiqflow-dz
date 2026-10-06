/**
 * BoutiqFlow DZ — Dead Letter Queue & Quarantine Engine (INV-13-10, Requirements 26 & 55)
 * Captures malformed, corrupted, or repeatedly failing queue events into persistent quarantine,
 * preventing silent event loss and supporting controlled replay once root cause is remediated.
 */

const crypto = require('crypto');

class DeadLetterQueueService {
  constructor() {
    this.quarantinedEvents = new Map();
  }

  /**
   * Quarantines an unprocessable or corrupted event (INV-13-10)
   */
  async quarantineEvent(tx, {
    tenantId = null,
    queueName = 'DEFAULT',
    originalEventId = null,
    payload,
    errorReason,
    attemptHistory = [],
    replayEligible = true
  }) {
    const deadLetterId = `DLQ-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const deadLetterRecord = {
      id: deadLetterId,
      tenant_id: tenantId,
      queue_name: queueName,
      original_event_id: originalEventId,
      payload,
      error_reason: errorReason,
      attempt_history: attemptHistory,
      attempt_count: attemptHistory.length,
      replay_eligible: replayEligible,
      status: 'QUARANTINED',
      quarantined_at: now,
      resolved_at: null
    };

    this.quarantinedEvents.set(deadLetterId, deadLetterRecord);

    if (tx && tx.insert) {
      await tx.insert('audit_logs', {
        id: `AUD-${crypto.randomUUID().slice(0, 8)}`,
        tenant_id: tenantId || 'system',
        event_type: 'EVENT_QUARANTINED',
        actor_id: 'queue_worker',
        action: 'EVENT_QUARANTINED',
        details: { deadLetterId, queueName, errorReason, replayEligible },
        created_at: now
      });
    }

    return deadLetterRecord;
  }

  /**
   * Lists quarantined events
   */
  listQuarantined({ queueName = null, replayOnly = false } = {}) {
    const items = Array.from(this.quarantinedEvents.values());
    return items.filter(i =>
      (!queueName || i.queue_name === queueName) &&
      (!replayOnly || i.replay_eligible) &&
      i.status === 'QUARANTINED'
    );
  }

  /**
   * Replays an event from the Dead Letter Queue
   */
  async replayEvent(tx, deadLetterId, processorFn) {
    const item = this.quarantinedEvents.get(deadLetterId);
    if (!item) throw new Error(`Quarantined event ${deadLetterId} not found`);

    if (!item.replay_eligible) {
      throw new Error(`Event ${deadLetterId} is marked permanently ineligible for automated replay`);
    }

    try {
      const result = await processorFn(item.payload);
      item.status = 'RESOLVED';
      item.resolved_at = new Date().toISOString();
      return { success: true, deadLetterId, result };
    } catch (err) {
      item.attempt_history.push({
        replayedAt: new Date().toISOString(),
        error: err.message
      });
      item.attempt_count++;
      throw err;
    }
  }
}

const defaultDLQ = new DeadLetterQueueService();

module.exports = {
  DeadLetterQueueService,
  defaultDLQ
};
