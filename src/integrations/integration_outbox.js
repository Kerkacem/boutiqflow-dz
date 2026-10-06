/**
 * BoutiqFlow DZ — Integration Outbox & Two-Phase Resilience Service (INV-10-08, INV-10-09, Critical Test 51)
 * Decouples internal transaction commits from external third-party API dispatch.
 * An external API outage or crash NEVER rolls back a committed local sale or inventory mutation.
 */

const { generateUUIDv7 } = require('../db/utils');
const { OUTBOX_STATUSES } = require('./constants');

class IntegrationOutboxService {
  /**
   * Enqueues an outbound event to be dispatched to external platforms
   */
  static async enqueue(tx, {
    integrationId,
    eventType,
    aggregateType,
    aggregateId,
    payload = {}
  }) {
    const tenantId = tx.session.tenantId;
    const eventId = generateUUIDv7();

    const record = {
      id: eventId,
      event_id: eventId,
      tenant_id: tenantId,
      integration_id: integrationId,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      payload,
      status: OUTBOX_STATUSES.QUEUED,
      attempt_count: 0,
      next_attempt_at: new Date().toISOString(),
      last_error: null,
      created_at: new Date().toISOString()
    };

    return await tx.insert('integration_outbox', record);
  }

  /**
   * Dispatches a queued outbox item with two-phase crash resilience (Critical Test 51)
   */
  static async processItem(tx, {
    itemId,
    externalApiCaller,
    externalResourceLookup = null
  }) {
    const item = await tx.findById('integration_outbox', itemId);
    if (!item) throw new Error(`Outbox item ${itemId} not found`);

    // 1. Worker crash recovery check: Check if external call already succeeded remotely before crash
    if (externalResourceLookup) {
      const alreadyExists = await externalResourceLookup(item);
      if (alreadyExists) {
        return await tx.update('integration_outbox', item.id, {
          status: OUTBOX_STATUSES.DELIVERED,
          delivered_at: new Date().toISOString(),
          recovered_from_crash: true
        });
      }
    }

    // 2. Mark as SENDING
    await tx.update('integration_outbox', item.id, {
      status: OUTBOX_STATUSES.SENDING,
      attempt_count: (item.attempt_count || 0) + 1
    });

    try {
      // 3. Call external platform
      const apiResult = await externalApiCaller(item);

      // 4. On success, mark DELIVERED
      return await tx.update('integration_outbox', item.id, {
        status: OUTBOX_STATUSES.DELIVERED,
        result: apiResult,
        delivered_at: new Date().toISOString()
      });
    } catch (err) {
      // 5. On failure, mark RETRYABLE_FAILURE without rolling back local business state (INV-10-08)
      const nextDelayMs = Math.min(1000 * Math.pow(2, item.attempt_count || 1), 60000);
      const nextAttemptAt = new Date(Date.now() + nextDelayMs).toISOString();

      return await tx.update('integration_outbox', item.id, {
        status: OUTBOX_STATUSES.RETRYABLE_FAILURE,
        last_error: {
          message: err.message,
          code: err.code || 'EXTERNAL_API_ERROR',
          failedAt: new Date().toISOString()
        },
        next_attempt_at: nextAttemptAt
      });
    }
  }

  /**
   * Lists pending outbox items for a tenant
   */
  static async listPending(tx, { limit = 20 } = {}) {
    const tenantId = tx.session.tenantId;
    const items = await tx.query('integration_outbox', i =>
      i.tenant_id === tenantId &&
      (i.status === OUTBOX_STATUSES.QUEUED || i.status === OUTBOX_STATUSES.RETRYABLE_FAILURE)
    );
    return items.slice(0, limit);
  }
}

module.exports = {
  IntegrationOutboxService
};
