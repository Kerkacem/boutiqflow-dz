/**
 * BoutiqFlow DZ — Admin Override Service (INV-12-18)
 * Manages administrative grants, comp access, and explicit entitlement overrides.
 * Requires documented reason, approver, ticket reference, and scope.
 */

const crypto = require('crypto');
const { EntitlementEngine } = require('./entitlement_engine');

class AdminOverrideService {
  /**
   * Create an administrative override / comp grant
   */
  static async createOverride(tx, {
    tenantId,
    featureCode,
    overrideValue = true,
    type = 'COMP',
    reason,
    actor,
    ticketReference,
    startsAt = new Date().toISOString(),
    expiresAt
  }) {
    if (!reason || reason.trim().length < 5) {
      const err = new Error('Admin override requires a documented business reason of at least 5 characters');
      err.code = 'REASON_REQUIRED';
      throw err;
    }
    if (!actor) {
      const err = new Error('Admin override requires an authoritative actor/approver');
      err.code = 'ACTOR_REQUIRED';
      throw err;
    }
    if (!featureCode) {
      const err = new Error('Feature code is required for override');
      err.code = 'FEATURE_REQUIRED';
      throw err;
    }

    const overrideId = `OVR-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const record = {
      id: overrideId,
      tenant_id: tenantId,
      feature_code: featureCode,
      override_value: overrideValue,
      type,
      reason,
      actor,
      ticket_reference: ticketReference || null,
      starts_at: startsAt,
      expires_at: expiresAt || null,
      revoked_at: null,
      revoked_by: null,
      created_at: now
    };

    await tx.insert('entitlement_overrides', record);

    // Audit log
    await tx.insert('audit_logs', {
      id: `AUD-${crypto.randomUUID().slice(0, 8)}`,
      tenant_id: tenantId,
      event_type: 'ADMIN_OVERRIDE_CREATED',
      actor_id: actor,
      action: 'ADMIN_OVERRIDE_CREATED',
      details: {
        overrideId,
        featureCode,
        type,
        reason,
        ticketReference,
        startsAt,
        expiresAt
      },
      created_at: now
    });

    // Invalidate entitlement cache immediately (INV-12-22)
    EntitlementEngine.invalidateTenantCache(tenantId);

    return record;
  }

  /**
   * Revoke an active override
   */
  static async revokeOverride(tx, { overrideId, actor, reason }) {
    if (!reason) {
      const err = new Error('Override revocation requires a reason');
      err.code = 'REASON_REQUIRED';
      throw err;
    }

    const existing = await tx.getById('entitlement_overrides', overrideId);
    if (!existing) {
      const err = new Error(`Override ${overrideId} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    const now = new Date().toISOString();
    await tx.update('entitlement_overrides', overrideId, {
      expires_at: new Date(Date.now() - 5000).toISOString(),
      revoked_at: now,
      revoked_by: actor,
      revocation_reason: reason,
      updated_at: now
    });

    await tx.insert('audit_logs', {
      id: `AUD-${crypto.randomUUID().slice(0, 8)}`,
      tenant_id: existing.tenant_id,
      event_type: 'ADMIN_OVERRIDE_REVOKED',
      actor_id: actor,
      action: 'ADMIN_OVERRIDE_REVOKED',
      details: { overrideId, reason },
      created_at: now
    });

    EntitlementEngine.invalidateTenantCache(existing.tenant_id);
    return { success: true, overrideId };
  }
}

module.exports = { AdminOverrideService };
