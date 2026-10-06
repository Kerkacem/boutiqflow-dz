/**
 * BoutiqFlow DZ — Data Subject Rights Service (Law 18-07 Art. 32-36, INV-11-11, INV-11-12)
 * Handles ACCESS, RECTIFICATION, and OBJECTION requests with mandatory identity verification
 * and strict financial ledger immutability protection.
 */

const { generateUUIDv7 } = require('../db/utils');
const { ProcessingJournalService } = require('./processing_journal');
const {
  PRIVACY_REQUEST_TYPES,
  PRIVACY_REQUEST_STATUSES,
  PROCESSING_OPERATIONS,
  COMPLIANCE_ERRORS
} = require('./constants');

class PrivacyRequestService {
  /**
   * Submits a new Data Subject Right request (starts in CREATED status)
   */
  static async createRequest(tx, {
    dataSubjectType = 'CUSTOMER',
    identifier, // e.g. phone number or customer ID
    type = PRIVACY_REQUEST_TYPES.ACCESS,
    grounds = '',
    requestedScope = 'ALL'
  }) {
    if (!identifier || !type) {
      throw new Error('Privacy request requires identifier and request type');
    }

    const tenantId = tx.session.tenantId;
    const requestId = generateUUIDv7();

    const requestRecord = {
      id: requestId,
      tenant_id: tenantId,
      data_subject_type: dataSubjectType,
      identifier: String(identifier),
      type,
      grounds,
      requested_scope: requestedScope,
      status: PRIVACY_REQUEST_STATUSES.CREATED,
      identity_verified: false,
      identity_verification_method: null,
      verification_evidence: null,
      decision: null,
      decision_reason: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await tx.insert('privacy_requests', requestRecord);

    await tx.insert('privacy_request_audits', {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      request_id: requestId,
      action: 'REQUEST_CREATED',
      actor_id: tx.session.userId || 'system',
      details: { type, identifier, dataSubjectType },
      created_at: new Date().toISOString()
    });

    return requestRecord;
  }

  /**
   * Verifies identity of data subject before disclosing or altering data (INV-11-11)
   */
  static async verifyIdentity(tx, requestId, {
    method = 'SMS_OTP',
    evidenceReference,
    verifiedBy = null
  }) {
    const request = await tx.findById('privacy_requests', requestId);
    if (!request) throw new Error(`Privacy request ${requestId} not found`);

    if (!evidenceReference) {
      throw new Error('Identity verification requires proportionate documented evidence');
    }

    const updated = await tx.update('privacy_requests', request.id, {
      status: PRIVACY_REQUEST_STATUSES.IDENTITY_VERIFIED,
      identity_verified: true,
      identity_verification_method: method,
      verification_evidence: evidenceReference,
      verified_by: verifiedBy || tx.session.userId || 'dpo_officer',
      verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    await tx.insert('privacy_request_audits', {
      id: generateUUIDv7(),
      tenant_id: tx.session.tenantId,
      request_id: requestId,
      action: 'IDENTITY_VERIFIED',
      actor_id: verifiedBy || tx.session.userId || 'dpo_officer',
      details: { method, evidenceReference },
      created_at: new Date().toISOString()
    });

    return updated;
  }

  /**
   * Fulfills an ACCESS, RECTIFICATION, or OBJECTION request (INV-11-11, INV-11-12)
   */
  static async fulfillRequest(tx, requestId, options = {}) {
    const request = await tx.findById('privacy_requests', requestId);
    if (!request) throw new Error(`Privacy request ${requestId} not found`);

    // 1. Mandatory Identity Verification Gate (INV-11-11)
    if (!request.identity_verified || request.status === PRIVACY_REQUEST_STATUSES.CREATED) {
      const err = new Error('Identity Gate Violation: Requester identity must be verified prior to fulfilling request (INV-11-11)');
      err.code = COMPLIANCE_ERRORS.IDENTITY_NOT_VERIFIED;
      throw err;
    }

    const tenantId = tx.session.tenantId;
    let fulfillmentResult = {};

    // 2. Type: ACCESS
    if (request.type === PRIVACY_REQUEST_TYPES.ACCESS) {
      // Find customer data matching identifier
      const customers = await tx.query('customers', c =>
        c.tenant_id === tenantId && (c.phone === request.identifier || c.id === request.identifier)
      );

      const customer = customers.length > 0 ? customers[0] : null;
      let orderHistory = [];

      if (customer) {
        orderHistory = await tx.query('online_orders', o =>
          o.tenant_id === tenantId && (o.customer_id === customer.id || o.customer_phone === customer.phone)
        );
      }

      fulfillmentResult = {
        dataCategories: ['IDENTITY', 'CONTACT', 'ADDRESS', 'ORDER_HISTORY'],
        customerProfile: customer ? {
          name: customer.name,
          phone: customer.phone,
          address: customer.address
        } : null,
        ordersCount: orderHistory.length,
        orders: orderHistory.map(o => ({
          orderId: o.id,
          date: o.created_at,
          totalCentimes: o.total_centimes ? o.total_centimes.toString() : '0',
          status: o.status
        })),
        recipients: ['DELIVERY_COURIER_YALIDINE', 'IN_STORE_CASHIER'],
        excludedInternalSecrets: ['API_KEYS', 'PASSWORD_HASHES', 'INTERNAL_SYSTEM_LOGS']
      };

      await ProcessingJournalService.logOperation(tx, {
        actorId: tx.session.userId || 'privacy_officer',
        actorRole: tx.session.role || 'DPO',
        operation: PROCESSING_OPERATIONS.EXTRACTED,
        dataSubjectType: request.data_subject_type,
        dataSubjectId: customer ? customer.id : request.identifier,
        purpose: 'DATA_SUBJECT_ACCESS_REQUEST',
        referenceType: 'PRIVACY_REQUEST',
        referenceId: requestId,
        details: { ordersCount: orderHistory.length }
      });
    }

    // 3. Type: RECTIFICATION (INV-11-12)
    else if (request.type === PRIVACY_REQUEST_TYPES.RECTIFICATION) {
      const updates = options.updates || {};

      // Guard: Cannot alter historical financial transactions under guise of rectification (INV-11-12)
      if (updates.historicalSale || updates.financialCorrection || updates.salePrice || updates.costPrice) {
        const err = new Error('Financial Ledger Violation: Rectification cannot alter immutable historical financial records (INV-11-12)');
        err.code = COMPLIANCE_ERRORS.FINANCIAL_HISTORY_IMMUTABLE;
        throw err;
      }

      // Update customer profile mutable fields safely
      const customers = await tx.query('customers', c =>
        c.tenant_id === tenantId && (c.phone === request.identifier || c.id === request.identifier)
      );

      if (customers.length > 0) {
        const cust = customers[0];
        await tx.update('customers', cust.id, {
          name: updates.name || cust.name,
          address: updates.address || cust.address,
          updated_at: new Date().toISOString()
        });
      }

      fulfillmentResult = {
        rectified: true,
        updatedFields: Object.keys(updates)
      };

      await ProcessingJournalService.logOperation(tx, {
        actorId: tx.session.userId || 'privacy_officer',
        actorRole: tx.session.role || 'DPO',
        operation: PROCESSING_OPERATIONS.MODIFIED,
        dataSubjectType: request.data_subject_type,
        dataSubjectId: request.identifier,
        purpose: 'DATA_SUBJECT_RECTIFICATION',
        referenceType: 'PRIVACY_REQUEST',
        referenceId: requestId,
        details: { updatedFields: Object.keys(updates) }
      });
    }

    // 4. Type: OBJECTION
    else if (request.type === PRIVACY_REQUEST_TYPES.OBJECTION) {
      const targetActivity = options.processingActivity || 'MARKETING';
      let decision = 'APPROVED';
      let reason = 'Direct marketing opt-out honored immediately.';

      if (targetActivity === 'ACCOUNTING' || targetActivity === 'LEGAL_OBLIGATION') {
        decision = 'REJECTED';
        reason = 'Processing is required by Algerian Commercial and Tax statutory obligations.';
      }

      fulfillmentResult = {
        decision,
        reason,
        targetActivity
      };

      await ProcessingJournalService.logOperation(tx, {
        actorId: tx.session.userId || 'privacy_officer',
        actorRole: tx.session.role || 'DPO',
        operation: PROCESSING_OPERATIONS.LOCKED,
        dataSubjectType: request.data_subject_type,
        dataSubjectId: request.identifier,
        purpose: 'DATA_SUBJECT_OBJECTION_ASSESSMENT',
        referenceType: 'PRIVACY_REQUEST',
        referenceId: requestId,
        details: { decision, reason, targetActivity }
      });
    }

    // Update request to FULFILLED
    const updated = await tx.update('privacy_requests', request.id, {
      status: PRIVACY_REQUEST_STATUSES.FULFILLED,
      decision: fulfillmentResult.decision || 'APPROVED',
      decision_reason: fulfillmentResult.reason || 'Request fulfilled within statutory scope',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    await tx.insert('privacy_request_audits', {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      request_id: requestId,
      action: 'REQUEST_FULFILLED',
      actor_id: tx.session.userId || 'privacy_officer',
      details: { type: request.type, decision: updated.decision },
      created_at: new Date().toISOString()
    });

    return {
      request: updated,
      result: fulfillmentResult
    };
  }
}

module.exports = {
  PrivacyRequestService
};
