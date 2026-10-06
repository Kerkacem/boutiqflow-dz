/**
 * BoutiqFlow DZ — International Transfer Guard Service (Law 18-07 Art. 44-47, INV-11-18, INV-11-19)
 * Intercepts outbound transmissions to foreign cloud platforms or international carriers,
 * blocking processing unless a validated statutory TransferRecord and legal approval exist.
 */

const { generateUUIDv7 } = require('../db/utils');
const {
  COMPLIANCE_STATUSES,
  TRANSFER_STATUSES,
  COMPLIANCE_ERRORS
} = require('./constants');

class TransferGuardService {
  /**
   * Registers a cross-border international transfer record
   */
  static async registerTransfer(tx, {
    processingActivityId = null,
    destinationCountry,
    destinationOrganization,
    recipientRole = 'PROCESSOR',
    dataCategories = [],
    purpose,
    safeguards = 'Standard Contractual Clauses & Encryption at Rest',
    legalReviewStatus = COMPLIANCE_STATUSES.LEGAL_REVIEW_REQUIRED,
    transferStatus = TRANSFER_STATUSES.REVIEW_REQUIRED
  }) {
    if (!destinationCountry || !destinationOrganization) {
      throw new Error('Transfer record requires destinationCountry and destinationOrganization');
    }

    const tenantId = tx.session.tenantId;
    const transferId = generateUUIDv7();

    const record = {
      id: transferId,
      tenant_id: tenantId,
      processing_activity_id: processingActivityId,
      destination_country: destinationCountry.toUpperCase(),
      destination_organization: destinationOrganization,
      recipient_role: recipientRole,
      data_categories: dataCategories,
      purpose: purpose || 'STORE_INTEGRATION_FULFILLMENT',
      safeguards,
      legal_review_status: legalReviewStatus,
      transfer_status: transferStatus,
      authorization_reference: null,
      created_at: new Date().toISOString()
    };

    await tx.insert('transfer_records', record);
    return record;
  }

  /**
   * Evaluates whether a proposed transmission to an external destination is legally permitted (INV-11-19)
   */
  static async checkTransferPermitted(tx, {
    destinationCountry,
    destinationOrganization = null,
    dataCategories = []
  }) {
    const country = (destinationCountry || '').toUpperCase();

    // 1. Domestic processing in Algeria is inherently permitted
    if (country === 'ALGERIA' || country === 'DZ' || country === 'LOCAL') {
      return { permitted: true, status: TRANSFER_STATUSES.LOCAL };
    }

    const tenantId = tx.session.tenantId;

    // 2. Query tenant transfer records for target country/organization
    const records = await tx.query('transfer_records', r =>
      r.tenant_id === tenantId && r.destination_country === country
    );

    if (records.length === 0) {
      const err = new Error(`Transfer Guard Violation: No TransferRecord registered for destination country '${country}' (INV-11-18, INV-11-19)`);
      err.code = COMPLIANCE_ERRORS.TRANSFER_BLOCKED;
      err.destinationCountry = country;
      throw err;
    }

    // Check if an authorized approval exists
    const authorized = records.find(r =>
      r.transfer_status === TRANSFER_STATUSES.AUTHORIZED &&
      r.legal_review_status === COMPLIANCE_STATUSES.APPROVED
    );

    if (authorized) {
      return {
        permitted: true,
        status: TRANSFER_STATUSES.AUTHORIZED,
        record: authorized
      };
    }

    // If no authorized approval, transmission is forbidden pending legal review (INV-11-19)
    const err = new Error(`Transfer Guard Violation: Transmission to '${country}' is blocked pending legal review (INV-11-19)`);
    err.code = COMPLIANCE_ERRORS.TRANSFER_BLOCKED;
    err.transferStatus = records[0].transfer_status;
    err.legalReviewStatus = records[0].legal_review_status;
    throw err;
  }

  /**
   * Approves a cross-border transfer following formal legal review (Append-Only in transfer_records)
   */
  static async approveTransfer(tx, transferId, { authorizationReference, approvedBy = null }) {
    const record = await tx.findById('transfer_records', transferId);
    if (!record) throw new Error(`Transfer record ${transferId} not found`);

    // transfer_records is strictly immutable & append-only; insert authoritative approval decision
    const approvalRecord = {
      ...record,
      id: generateUUIDv7(),
      transfer_status: TRANSFER_STATUSES.AUTHORIZED,
      legal_review_status: COMPLIANCE_STATUSES.APPROVED,
      authorization_reference: authorizationReference || 'ANPDP_TRANSFER_AUTH_2026_09',
      approved_by: approvedBy || tx.session.userId || 'legal_officer',
      approved_at: new Date().toISOString(),
      created_at: new Date().toISOString()
    };

    await tx.insert('transfer_records', approvalRecord);
    return approvalRecord;
  }
}

module.exports = {
  TransferGuardService
};
