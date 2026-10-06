/**
 * BoutiqFlow DZ — Subprocessor & DPA Inventory Service (Law 25-11 Art. 41, INV-11-22, INV-11-23)
 * Tracks all third-party subprocessors (hosting, email, couriers, payment gateways)
 * and Data Processing Agreement (DPA) lifecycle versions.
 */

const { generateUUIDv7 } = require('../db/utils');
const {
  COMPLIANCE_STATUSES
} = require('./constants');

class SubprocessorService {
  /**
   * Registers a third-party subprocessor (INV-11-22)
   */
  static async registerSubprocessor(tx, {
    name,
    purpose,
    dataCategories = [],
    location = 'ALGERIA',
    contractStatus = 'EXECUTED',
    securityReview = COMPLIANCE_STATUSES.APPROVED,
    active = true
  }) {
    if (!name || !purpose) {
      throw new Error('Subprocessor requires name and purpose');
    }

    const tenantId = tx.session.tenantId;
    const record = {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      name,
      purpose,
      data_categories: dataCategories,
      location,
      contract_status: contractStatus,
      security_review: securityReview,
      active: Boolean(active),
      created_at: new Date().toISOString()
    };

    await tx.insert('subprocessors', record);
    return record;
  }

  /**
   * Creates a Data Processing Agreement (DPA) record tracking metadata (INV-11-23)
   */
  static async createDpaRecord(tx, {
    controller,
    processor,
    effectiveDate = new Date().toISOString(),
    version = '1.0',
    status = 'UNDER_REVIEW', // Default is UNDER_REVIEW, never automatically approved
    subprocessors = [],
    securityAnnex = 'ANNEX_SECURITY_MEASURES_V1'
  }) {
    if (!controller || !processor) {
      throw new Error('DPA record requires controller and processor');
    }

    const tenantId = tx.session.tenantId;
    const dpaId = generateUUIDv7();

    const dpaRecord = {
      id: dpaId,
      tenant_id: tenantId,
      controller,
      processor,
      effective_date: effectiveDate,
      version,
      status, // DRAFT, UNDER_REVIEW, APPROVED, REJECTED, EXPIRED
      subprocessors,
      security_annex: securityAnnex,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await tx.insert('dpa_records', dpaRecord);
    return dpaRecord;
  }

  /**
   * Lists all active subprocessors for tenant
   */
  static async listSubprocessors(tx) {
    return await tx.query('subprocessors', s => s.tenant_id === tx.session.tenantId);
  }

  /**
   * Updates DPA status following formal bilateral review (INV-11-23)
   */
  static async updateDpaStatus(tx, dpaId, { status, reviewedBy = null }) {
    const dpa = await tx.findById('dpa_records', dpaId);
    if (!dpa) throw new Error(`DPA record ${dpaId} not found`);

    return await tx.update('dpa_records', dpa.id, {
      status,
      reviewed_by: reviewedBy || tx.session.userId || 'legal_officer',
      updated_at: new Date().toISOString()
    });
  }
}

module.exports = {
  SubprocessorService
};
