/**
 * BoutiqFlow DZ — Usage Metering Service (INV-12-24, INV-12-25, INV-12-26)
 * Ingestion of idempotent canonical usage events, maintaining materialized aggregates,
 * and supporting full aggregate rebuildability.
 */

const crypto = require('crypto');
const { USAGE_METRICS } = require('./constants');

class UsageMeteringService {
  /**
   * Record a canonical usage event (idempotent on referenceId + source + metric)
   */
  static async recordEvent(tx, {
    tenantId,
    metric,
    quantity = 1,
    source = 'SYSTEM',
    referenceId,
    occurredAt = new Date().toISOString()
  }) {
    if (!tenantId) throw new Error('tenantId is required');
    if (!metric) throw new Error('metric is required');

    // Check idempotency if referenceId is provided
    if (referenceId) {
      const existing = await tx.query('usage_events', e =>
        e.tenant_id === tenantId &&
        e.metric === metric &&
        e.reference_id === referenceId &&
        e.source === source
      );
      if (existing.length > 0) {
        // Idempotent duplicate: return existing event and current aggregate
        const agg = await this.getAggregate(tx, tenantId, metric);
        return { event: existing[0], aggregate: agg, duplicate: true };
      }
    }

    const eventId = `USE-${crypto.randomUUID().slice(0, 8)}`;
    const event = {
      id: eventId,
      tenant_id: tenantId,
      metric,
      quantity,
      source,
      reference_id: referenceId || null,
      occurred_at: occurredAt,
      created_at: new Date().toISOString()
    };

    await tx.insert('usage_events', event);

    // Increment materialized aggregate
    const agg = await this._incrementAggregate(tx, tenantId, metric, quantity);

    return { event, aggregate: agg, duplicate: false };
  }

  /**
   * Fetch materialized aggregate for a tenant & metric
   */
  static async getAggregate(tx, tenantId, metric) {
    const records = await tx.query('usage_aggregates', a =>
      a.tenant_id === tenantId && a.metric === metric
    );
    if (records.length > 0) {
      return records[0];
    }
    return {
      tenant_id: tenantId,
      metric,
      current_value: 0,
      last_updated_at: new Date().toISOString()
    };
  }

  /**
   * Rebuild materialized aggregate from scratch using canonical events
   */
  static async rebuildAggregate(tx, tenantId, metric) {
    const events = await tx.query('usage_events', e =>
      e.tenant_id === tenantId && e.metric === metric
    );

    let total = 0;
    for (const ev of events) {
      total += (ev.quantity || 0);
    }

    const existing = await tx.query('usage_aggregates', a =>
      a.tenant_id === tenantId && a.metric === metric
    );

    const now = new Date().toISOString();
    if (existing.length > 0) {
      await tx.update('usage_aggregates', existing[0].id, {
        current_value: total,
        last_updated_at: now
      });
      return { ...existing[0], current_value: total, last_updated_at: now };
    } else {
      const aggId = `AGG-${crypto.randomUUID().slice(0, 8)}`;
      const newAgg = {
        id: aggId,
        tenant_id: tenantId,
        metric,
        current_value: total,
        last_updated_at: now
      };
      await tx.insert('usage_aggregates', newAgg);
      return newAgg;
    }
  }

  static async _incrementAggregate(tx, tenantId, metric, quantity) {
    const existing = await tx.query('usage_aggregates', a =>
      a.tenant_id === tenantId && a.metric === metric
    );

    const now = new Date().toISOString();
    if (existing.length > 0) {
      const newVal = (existing[0].current_value || 0) + quantity;
      await tx.update('usage_aggregates', existing[0].id, {
        current_value: newVal,
        last_updated_at: now
      });
      return { ...existing[0], current_value: newVal, last_updated_at: now };
    } else {
      const aggId = `AGG-${crypto.randomUUID().slice(0, 8)}`;
      const newAgg = {
        id: aggId,
        tenant_id: tenantId,
        metric,
        current_value: quantity,
        last_updated_at: now
      };
      await tx.insert('usage_aggregates', newAgg);
      return newAgg;
    }
  }
}

module.exports = { UsageMeteringService };
