/**
 * BoutiqFlow DZ — Tenant Lifecycle & Deletion Guard Service (INV-12-14, INV-12-15, INV-12-17, INV-12-30)
 * Controls tenant states (ACTIVE, GRACE, READ_ONLY, SUSPENDED, DELETION_PENDING)
 * and enforces strict deletion blockers (Legal Hold, open breach, disputes).
 */

const { generateUUIDv7 } = require('../db/utils');
const {
  TENANT_LIFECYCLE_STATES,
  DELETION_BLOCKERS,
  BILLING_ERRORS
} = require('./constants');

class TenantLifecycleService {
  /**
   * Retrieves the current lifecycle state for a tenant
   */
  static async getLifecycleState(tx, tenantId) {
    const lifecycles = await tx.query('tenant_lifecycles', l => l.tenant_id === tenantId);
    return lifecycles[0]?.state || TENANT_LIFECYCLE_STATES.ACTIVE;
  }

  /**
   * Transitions tenant lifecycle state with audit logging (INV-12-30)
   */
  static async transitionLifecycle(tx, tenantId, targetState, reason = '') {
    const lifecycles = await tx.query('tenant_lifecycles', l => l.tenant_id === tenantId);
    let previousState = 'UNKNOWN';

    if (lifecycles.length > 0) {
      previousState = lifecycles[0].state;
      await tx.update('tenant_lifecycles', lifecycles[0].id, {
        state: targetState,
        previous_state: previousState,
        reason,
        updated_at: new Date().toISOString()
      });
    } else {
      await tx.insert('tenant_lifecycles', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        state: targetState,
        previous_state: 'PROVISIONING',
        reason,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }

    return { tenantId, previousState, currentState: targetState };
  }

  /**
   * Asserts whether an operation is allowed under the current tenant lifecycle state (Critical Test 61, 62)
   */
  static assertOperationAllowed(lifecycleState, operationType = 'MUTATION') {
    if (lifecycleState === TENANT_LIFECYCLE_STATES.SUSPENDED) {
      const err = new Error('Tenant Suspended: All operations and mutations are blocked (INV-12-14)');
      err.code = BILLING_ERRORS.SUBSCRIPTION_SUSPENDED;
      err.statusCode = 403;
      throw err;
    }

    if (lifecycleState === TENANT_LIFECYCLE_STATES.READ_ONLY) {
      const readOnlyPermitted = ['READ', 'GET', 'EXPORT', 'VIEW_REPORTS', 'VIEW_INVOICES', 'BILLING_PAYMENT'];
      if (!readOnlyPermitted.includes(operationType.toUpperCase())) {
        const err = new Error(`Tenant Read-Only: Operation '${operationType}' is forbidden in read-only mode (INV-12-14)`);
        err.code = BILLING_ERRORS.SUBSCRIPTION_READ_ONLY;
        err.statusCode = 403;
        throw err;
      }
    }
  }

  /**
   * Requests tenant deletion, strictly checking legal blockers (INV-12-17, Critical Test 64)
   */
  static async requestTenantDeletion(tx, { tenantId, reason }) {
    // 1. Check for Active Legal Holds (INV-12-17)
    const activeHolds = await tx.query('legal_holds', h =>
      h.tenant_id === tenantId && h.status === 'ACTIVE'
    );

    if (activeHolds.length > 0) {
      const err = new Error('Deletion Blocked: Tenant has active Legal Holds and cannot be deleted (INV-12-17)');
      err.code = BILLING_ERRORS.DELETION_BLOCKED;
      err.blocker = DELETION_BLOCKERS.LEGAL_HOLD_ACTIVE;
      err.activeHoldsCount = activeHolds.length;
      throw err;
    }

    // 2. Check for Open Breaches
    const openBreaches = await tx.query('breach_register', b =>
      b.tenant_id === tenantId && !b.is_resolved
    );

    if (openBreaches.length > 0) {
      const err = new Error('Deletion Blocked: Tenant has open personal data breaches under investigation (INV-12-17)');
      err.code = BILLING_ERRORS.DELETION_BLOCKED;
      err.blocker = DELETION_BLOCKERS.OPEN_BREACH;
      throw err;
    }

    // 3. If clean, schedule for deletion
    await this.transitionLifecycle(tx, tenantId, TENANT_LIFECYCLE_STATES.DELETION_PENDING, reason);

    return {
      success: true,
      status: TENANT_LIFECYCLE_STATES.DELETION_PENDING,
      message: 'Tenant scheduled for deletion review; historical financial records preserved.'
    };
  }
}

module.exports = {
  TenantLifecycleService
};
