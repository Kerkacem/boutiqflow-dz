/**
 * BoutiqFlow DZ — Privacy Access Policy & Super Admin Boundary (INV-11-20, INV-11-21)
 * Enforces role-based field access, masking rules, and strictly prohibits default
 * Super Admin browsing of tenant customer personal data without justified support sessions.
 */

const { generateUUIDv7 } = require('../db/utils');
const { ProcessingJournalService } = require('./processing_journal');
const { DataMaskingService } = require('./data_masking');
const {
  FIELD_CLASSIFICATIONS,
  PROCESSING_OPERATIONS,
  COMPLIANCE_ERRORS
} = require('./constants');

const FIELD_TAXONOMY = {
  'CUSTOMER.name': { classification: FIELD_CLASSIFICATIONS.PERSONAL, allowedRoles: ['OWNER', 'MANAGER', 'CASHIER'] },
  'CUSTOMER.phone': { classification: FIELD_CLASSIFICATIONS.PERSONAL, allowedRoles: ['OWNER', 'MANAGER', 'CASHIER'], maskForRoles: ['CASHIER'] },
  'CUSTOMER.address': { classification: FIELD_CLASSIFICATIONS.PERSONAL, allowedRoles: ['OWNER', 'MANAGER'], hideForRoles: ['CASHIER'] },
  'CUSTOMER.credit_balance': { classification: FIELD_CLASSIFICATIONS.SENSITIVE, allowedRoles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
  'USER.password_hash': { classification: FIELD_CLASSIFICATIONS.HIGH_RISK, allowedRoles: [] },
  'INTEGRATION.access_token': { classification: FIELD_CLASSIFICATIONS.SECRET, allowedRoles: [] }
};

class PrivacyAccessPolicy {
  /**
   * Evaluates field access and applies masking rules (Privacy by Design)
   */
  static authorizeFieldAccess({ field, userRole, isSupportSessionActive = false }) {
    // 1. Super Admin Boundary: Zero default access to tenant customer PII (INV-11-20)
    if (userRole === 'SUPER_ADMIN' && !isSupportSessionActive) {
      const err = new Error('Super Admin Privacy Boundary: Default browsing of customer PII is forbidden without an active support session (INV-11-20)');
      err.code = COMPLIANCE_ERRORS.SUPER_ADMIN_PII_ACCESS_DENIED;
      throw err;
    }

    const fieldConfig = FIELD_TAXONOMY[field];
    if (!fieldConfig) return { allowed: true, masked: false };

    // Secret fields are never exposed
    if (fieldConfig.classification === FIELD_CLASSIFICATIONS.SECRET || fieldConfig.classification === FIELD_CLASSIFICATIONS.HIGH_RISK) {
      return { allowed: false, masked: true, reason: 'SECRET_FIELD' };
    }

    const isAllowed = fieldConfig.allowedRoles.includes(userRole) || userRole === 'OWNER' || isSupportSessionActive;
    if (!isAllowed) {
      return { allowed: false, masked: true, reason: 'ROLE_FORBIDDEN' };
    }

    const shouldMask = (fieldConfig.maskForRoles || []).includes(userRole) && !isSupportSessionActive;
    return {
      allowed: true,
      masked: shouldMask
    };
  }

  /**
   * Sanitizes customer record according to role access policies
   */
  static sanitizeCustomer(customer, userRole, isSupportSessionActive = false) {
    if (!customer) return null;

    if (userRole === 'SUPER_ADMIN' && !isSupportSessionActive) {
      const err = new Error('Super Admin Privacy Boundary: Default browsing of customer PII is forbidden (INV-11-20)');
      err.code = COMPLIANCE_ERRORS.SUPER_ADMIN_PII_ACCESS_DENIED;
      throw err;
    }

    return DataMaskingService.sanitizeCustomerForRole(customer, userRole);
  }

  /**
   * Authorizes a time-bound, purpose-bound Support Session for Super Admin (INV-11-20)
   */
  static async createSupportSession(tx, {
    tenantId,
    actorId,
    ticketNumber,
    purpose,
    durationMinutes = 60
  }) {
    if (!ticketNumber || !purpose) {
      throw new Error('Support session requires documented ticketNumber and operational purpose');
    }

    const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
    const sessionId = generateUUIDv7();

    const session = {
      id: sessionId,
      tenant_id: tenantId,
      actor_id: actorId,
      ticket_number: ticketNumber,
      purpose,
      expires_at: expiresAt,
      created_at: new Date().toISOString()
    };

    await tx.insert('privacy_support_sessions', session);

    await ProcessingJournalService.logOperation(tx, {
      actorId,
      actorRole: 'SUPER_ADMIN',
      operation: PROCESSING_OPERATIONS.VIEWED,
      purpose: 'JUSTIFIED_SUPPORT_ACCESS',
      referenceType: 'SUPPORT_TICKET',
      referenceId: ticketNumber,
      details: { ticketNumber, purpose, durationMinutes, expiresAt }
    });

    return session;
  }

  /**
   * Emergency Break-Glass access for catastrophic support incidents
   */
  static async breakGlass(tx, {
    tenantId,
    actorId,
    reason
  }) {
    if (!reason || reason.length < 15) {
      throw new Error('Break-glass access requires comprehensive detailed justification');
    }

    const sessionId = generateUUIDv7();
    const session = {
      id: sessionId,
      tenant_id: tenantId,
      actor_id: actorId,
      ticket_number: `EMERGENCY-${Date.now()}`,
      purpose: `BREAK_GLASS: ${reason}`,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // Max 30 minutes
      created_at: new Date().toISOString()
    };

    await tx.insert('privacy_support_sessions', session);

    await ProcessingJournalService.logOperation(tx, {
      actorId,
      actorRole: 'SUPER_ADMIN',
      operation: PROCESSING_OPERATIONS.VIEWED,
      purpose: 'BREAK_GLASS_ACCESS',
      referenceType: 'EMERGENCY',
      referenceId: sessionId,
      details: { reason }
    });

    return session;
  }
}

module.exports = {
  PrivacyAccessPolicy,
  FIELD_TAXONOMY
};
