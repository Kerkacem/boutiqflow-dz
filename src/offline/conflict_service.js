/**
 * BoutiqFlow DZ — Conflict Resolution Service (INV-08-08, INV-08-14, INV-08-15)
 * Manages operator inspection and controlled resolution of synchronization conflicts.
 * Principle: Financial and stock conflicts are NEVER silently auto-resolved by Last-Write-Wins.
 */

const { ROLES, authorize, PERMISSIONS } = require('../rbac/permissions');
const { CONFLICT_RESOLUTION_ACTIONS } = require('./constants');

class ConflictService {
  /**
   * Lists unresolved synchronization conflicts for tenant
   */
  static async listPendingConflicts(tx) {
    const tenantId = tx.session.tenantId;
    return await tx.query('sync_conflicts', c =>
      c.tenant_id === tenantId && c.status === 'PENDING_REVIEW'
    );
  }

  /**
   * Resolves a conflict under strict RBAC authority (INV-08-10, INV-08-15)
   */
  static async resolveConflict(tx, {
    conflictId,
    action,
    notes = '',
    actorRole = ROLES.MANAGER,
    actorId = 'manager'
  }) {
    const tenantId = tx.session.tenantId;

    // RBAC: Only Manager or Owner can resolve conflicts (INV-08-10)
    if (actorRole === ROLES.CASHIER || actorRole === ROLES.STOCK_CLERK) {
      throw new Error('Access Denied: Cashier or Stock Clerk cannot resolve sync conflicts. Manager authorization required (INV-08-10).');
    }

    const conflict = await tx.findById('sync_conflicts', conflictId);
    if (!conflict || conflict.tenant_id !== tenantId) {
      throw new Error(`Conflict not found: ${conflictId}`);
    }

    if (conflict.status !== 'PENDING_REVIEW') {
      throw new Error(`Conflict ${conflictId} is already resolved (${conflict.status})`);
    }

    const validActions = Object.values(CONFLICT_RESOLUTION_ACTIONS);
    if (!validActions.includes(action)) {
      throw new Error(`Invalid conflict resolution action: ${action}`);
    }

    const updated = await tx.update('sync_conflicts', conflictId, {
      status: action === CONFLICT_RESOLUTION_ACTIONS.REJECT ? 'REJECTED' : 'RESOLVED',
      resolution_action: action,
      resolution_notes: notes,
      resolved_by: actorId,
      resolved_at: new Date().toISOString()
    });

    // Audit the resolution
    await tx.insert('audit_logs', {
      action: 'SYNC_CONFLICT_RESOLVED',
      actor_id: actorId,
      entity_type: 'sync_conflict',
      entity_id: conflictId,
      details: { action, notes, conflictType: conflict.conflict_type, operationId: conflict.operation_id },
      created_at: new Date().toISOString()
    });

    return updated;
  }
}

module.exports = {
  ConflictService
};
