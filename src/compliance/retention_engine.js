/**
 * BoutiqFlow DZ — Retention Engine & Legal Hold Subsystem (INV-11-08, INV-11-09, INV-11-12)
 * Enforces data retention schedules, protects records under active Legal Hold,
 * and preserves historical financial transaction integrity.
 */

const { generateUUIDv7 } = require('../db/utils');
const { ProcessingJournalService } = require('./processing_journal');
const {
  COMPLIANCE_STATUSES,
  RETENTION_ACTIONS,
  PROCESSING_OPERATIONS,
  COMPLIANCE_ERRORS
} = require('./constants');

class RetentionEngine {
  /**
   * Defines a retention policy for a specific data category or activity
   */
  static async createPolicy(tx, {
    dataCategory,
    processingActivityId = null,
    retentionDays = 730, // 2 years default
    retentionBasis = 'CONTRACT_EXECUTION',
    legalReviewStatus = COMPLIANCE_STATUSES.LEGAL_REVIEW_REQUIRED,
    actionAfterRetention = RETENTION_ACTIONS.ANONYMIZE
  }) {
    const tenantId = tx.session.tenantId;
    const policyId = generateUUIDv7();

    const policy = {
      id: policyId,
      tenant_id: tenantId,
      data_category: dataCategory,
      processing_activity_id: processingActivityId,
      retention_days: retentionDays,
      retention_basis: retentionBasis,
      legal_review_status: legalReviewStatus,
      action_after_retention: actionAfterRetention,
      created_at: new Date().toISOString()
    };

    await tx.insert('retention_policies', policy);
    return policy;
  }

  /**
   * Places an entity or scope under an active Legal Hold (INV-11-09)
   */
  static async createLegalHold(tx, {
    name,
    reason,
    scope = null,
    referenceType = null,
    referenceId = null
  }) {
    if (!name || !reason) {
      throw new Error('Legal Hold requires name and reason');
    }

    const tenantId = tx.session.tenantId;
    const effectiveScope = scope || (referenceId ? 'ENTITY' : 'ALL');

    const holdRecord = {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      name,
      reason,
      scope: effectiveScope,
      reference_type: referenceType,
      reference_id: referenceId ? String(referenceId) : null,
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
      released_at: null,
      release_reason: null
    };

    await tx.insert('legal_holds', holdRecord);

    await ProcessingJournalService.logOperation(tx, {
      actorId: tx.session.userId || 'system',
      actorRole: tx.session.role || 'LEGAL_OFFICER',
      operation: PROCESSING_OPERATIONS.LOCKED,
      purpose: 'LEGAL_HOLD_APPLIED',
      referenceType: 'LEGAL_HOLD',
      referenceId: holdRecord.id,
      details: { name, reason, scope: effectiveScope, referenceType, referenceId }
    });

    return holdRecord;
  }

  /**
   * Releases an active Legal Hold (INV-11-09)
   */
  static async releaseLegalHold(tx, holdId, releaseReason) {
    const hold = await tx.findById('legal_holds', holdId);
    if (!hold) throw new Error(`Legal Hold ${holdId} not found`);

    const updated = await tx.update('legal_holds', hold.id, {
      status: 'RELEASED',
      released_at: new Date().toISOString(),
      release_reason: releaseReason
    });

    await ProcessingJournalService.logOperation(tx, {
      actorId: tx.session.userId || 'system',
      actorRole: tx.session.role || 'LEGAL_OFFICER',
      operation: PROCESSING_OPERATIONS.MODIFIED,
      purpose: 'LEGAL_HOLD_RELEASED',
      referenceType: 'LEGAL_HOLD',
      referenceId: holdId,
      details: { releaseReason }
    });

    return updated;
  }

  /**
   * Runs the automated retention execution job respecting Legal Holds and Financial Integrity (INV-11-09, INV-11-12)
   */
  static async runRetentionJob(tx) {
    const tenantId = tx.session.tenantId;

    // 1. Fetch active legal holds
    const activeHolds = await tx.query('legal_holds', h =>
      h.tenant_id === tenantId && h.status === 'ACTIVE'
    );

    const isRecordHeld = (entityType, entityId) => {
      return activeHolds.some(h => {
        if (h.scope === 'ALL') return true;
        if (h.reference_type === entityType && String(h.reference_id) === String(entityId)) return true;
        return false;
      });
    };

    let processedCount = 0;
    let preservedUnderHoldCount = 0;
    let financialPreservedCount = 0;

    // 2. Scan customers eligible for retention expiry
    const customers = await tx.query('customers', c => c.tenant_id === tenantId);
    for (const customer of customers) {
      if (isRecordHeld('CUSTOMER', customer.id)) {
        preservedUnderHoldCount++;
        continue;
      }

      // Check if customer is expired (simulated criteria or flagged for erasure)
      if (customer.retention_expired) {
        // Execute Anonymization
        await tx.update('customers', customer.id, {
          name: 'Client Anonymisé',
          phone: `+213000${customer.id.substring(0, 6)}`,
          address: 'Adresse Effacée',
          retention_expired: false, // marked processed
          anonymized_at: new Date().toISOString()
        });

        await ProcessingJournalService.logOperation(tx, {
          actorId: 'system_retention_job',
          actorRole: 'SYSTEM',
          operation: PROCESSING_OPERATIONS.ERASED,
          dataSubjectType: 'CUSTOMER',
          dataSubjectId: customer.id,
          purpose: 'RETENTION_EXPIRY_ANONYMIZATION',
          details: { previousPhoneMasked: customer.phone ? `${customer.phone.substring(0, 4)}***` : '' }
        });

        processedCount++;
      }
    }

    // 3. Scan historical sales: Financial transactions are strictly preserved (INV-11-12)
    const sales = await tx.query('sales', s => s.tenant_id === tenantId);
    for (const sale of sales) {
      if (sale.retention_expired) {
        // Financial integrity: Sales prices, costs, line items must NEVER be deleted
        financialPreservedCount++;
      }
    }

    return {
      status: 'COMPLETED',
      processedCount,
      preservedUnderHoldCount,
      financialPreservedCount,
      executedAt: new Date().toISOString()
    };
  }
}

module.exports = {
  RetentionEngine
};
