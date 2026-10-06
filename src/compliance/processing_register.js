/**
 * Register of Processing Activities (Registre des activités de traitement)
 * Implements Article 39 bis of Algerian Law No. 18-07 as amended by Law No. 25-11.
 *
 * Each boutique merchant (Data Controller / Processor) maintains their register of processing
 * activities with clear purpose, legal basis, data categories, and DPIA gate enforcement.
 */

const { generateUUIDv7 } = require('../db/utils');
const {
  COMPLIANCE_STATUSES,
  PROCESSING_PURPOSES,
  LEGAL_BASES,
  DATA_SUBJECTS,
  DATA_CATEGORIES,
  COMPLIANCE_ERRORS
} = require('./constants');

const DEFAULT_RETAIL_ACTIVITIES = [
  {
    name: 'Fulfillment & Cash on Delivery Shipping',
    purpose: PROCESSING_PURPOSES.DELIVERY,
    legalBasis: LEGAL_BASES.CONTRACT_EXECUTION,
    controller: 'MERCHANT_BOUTIQUE',
    processor: 'BOUTIQFLOW_PLATFORM',
    dataCategories: [DATA_CATEGORIES.IDENTITY, DATA_CATEGORIES.CONTACT, DATA_CATEGORIES.ADDRESS, DATA_CATEGORIES.ORDER_DATA],
    dataSubjects: [DATA_SUBJECTS.CUSTOMER, DATA_SUBJECTS.DELIVERY_RECIPIENT],
    recipients: ['DELIVERY_COURIERS', 'CONFIRMATION_AGENTS'],
    retentionMonths: 24,
    internationalTransfer: false,
    dpiaRequired: false,
    dpiaStatus: COMPLIANCE_STATUSES.NOT_APPLICABLE,
    securityMeasures: ['ROW_LEVEL_SECURITY', 'ROLE_BASED_ACCESS_CONTROL', 'TLS_ENCRYPTION', 'AUDIT_LOGGING']
  },
  {
    name: 'Customer Debt Ledger (الكريدي)',
    purpose: PROCESSING_PURPOSES.ACCOUNTING,
    legalBasis: LEGAL_BASES.CONTRACT_EXECUTION,
    controller: 'MERCHANT_BOUTIQUE',
    processor: 'BOUTIQFLOW_PLATFORM',
    dataCategories: [DATA_CATEGORIES.IDENTITY, DATA_CATEGORIES.CONTACT, DATA_CATEGORIES.ACCOUNT_DATA],
    dataSubjects: [DATA_SUBJECTS.CUSTOMER],
    recipients: ['STORE_OWNER', 'STORE_MANAGER'],
    retentionMonths: 36,
    internationalTransfer: false,
    dpiaRequired: false,
    dpiaStatus: COMPLIANCE_STATUSES.NOT_APPLICABLE,
    securityMeasures: ['ROW_LEVEL_SECURITY', 'ROLE_BASED_ACCESS_CONTROL', 'ENCRYPTED_BACKUPS']
  },
  {
    name: 'Employee Shift & Access Control',
    purpose: PROCESSING_PURPOSES.EMPLOYEE_ACCESS,
    legalBasis: LEGAL_BASES.LEGAL_OBLIGATION,
    controller: 'MERCHANT_BOUTIQUE',
    processor: 'BOUTIQFLOW_PLATFORM',
    dataCategories: [DATA_CATEGORIES.IDENTITY, DATA_CATEGORIES.EMPLOYMENT_DATA, DATA_CATEGORIES.SECURITY_LOG_DATA],
    dataSubjects: [DATA_SUBJECTS.EMPLOYEE],
    recipients: ['STORE_OWNER'],
    retentionMonths: 60,
    internationalTransfer: false,
    dpiaRequired: false,
    dpiaStatus: COMPLIANCE_STATUSES.NOT_APPLICABLE,
    securityMeasures: ['PBKDF2_PASSWORD_HASHING', 'SESSION_TOKENS', 'AUDIT_LOGGING']
  }
];

class ProcessingRegisterService {
  /**
   * Initializes default processing activities for a newly provisioned tenant.
   */
  static async initializeDefaultActivities(tx) {
    const created = [];
    const tenantId = tx.session.tenantId;

    for (const activity of DEFAULT_RETAIL_ACTIVITIES) {
      const record = {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        name: activity.name,
        purpose: activity.purpose,
        legal_basis: activity.legalBasis,
        controller: activity.controller,
        processor: activity.processor,
        data_categories: activity.dataCategories,
        data_subjects: activity.dataSubjects,
        recipients: activity.recipients,
        retention_months: activity.retentionMonths,
        international_transfer: activity.internationalTransfer,
        dpia_required: activity.dpiaRequired,
        dpia_status: activity.dpiaStatus,
        status: COMPLIANCE_STATUSES.ACTIVE,
        security_measures: activity.securityMeasures,
        created_at: new Date().toISOString()
      };

      await tx.insert('processing_register', record);
      created.push(record);
    }
    return created;
  }

  /**
   * Lists all registered processing activities for the tenant.
   */
  static async listActivities(tx) {
    return await tx.query('processing_register', () => true);
  }

  /**
   * Adds a new processing activity with purpose validation and DPIA gate (INV-11-01, INV-11-02, INV-11-10).
   */
  static async registerActivity(tx, activityData) {
    if (!activityData.name || !activityData.purpose || !activityData.legalBasis) {
      throw new Error('Processing activity requires name, purpose, and legalBasis (INV-11-01, INV-11-02)');
    }

    const tenantId = tx.session.tenantId;
    const dpiaRequired = Boolean(activityData.dpiaRequired);
    const dpiaStatus = activityData.dpiaStatus || (dpiaRequired ? COMPLIANCE_STATUSES.REQUIRED : COMPLIANCE_STATUSES.NOT_APPLICABLE);

    // DPIA Gate (INV-11-10): If DPIA is required, status cannot start as ACTIVE unless DPIA is APPROVED
    let status = activityData.status || (dpiaRequired ? COMPLIANCE_STATUSES.IN_PROGRESS : COMPLIANCE_STATUSES.ACTIVE);
    if (dpiaRequired && status === COMPLIANCE_STATUSES.ACTIVE && dpiaStatus !== COMPLIANCE_STATUSES.APPROVED) {
      const err = new Error('DPIA Gate Violation: Processing activity cannot become ACTIVE without an APPROVED DPIA (INV-11-10)');
      err.code = COMPLIANCE_ERRORS.DPIA_REQUIRED_NOT_APPROVED;
      throw err;
    }

    const record = {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      name: activityData.name,
      purpose: activityData.purpose,
      legal_basis: activityData.legalBasis,
      controller: activityData.controller || 'MERCHANT_BOUTIQUE',
      processor: activityData.processor || 'BOUTIQFLOW_PLATFORM',
      data_categories: activityData.dataCategories || [DATA_CATEGORIES.CONTACT],
      data_subjects: activityData.dataSubjects || [DATA_SUBJECTS.CUSTOMER],
      recipients: activityData.recipients || [],
      retention_months: activityData.retentionMonths || 24,
      international_transfer: Boolean(activityData.internationalTransfer),
      dpia_required: dpiaRequired,
      dpia_status: dpiaStatus,
      status,
      security_measures: activityData.securityMeasures || ['ROW_LEVEL_SECURITY'],
      created_at: new Date().toISOString()
    };

    return await tx.insert('processing_register', record);
  }

  /**
   * Activates or updates an activity status, strictly checking the DPIA Gate (INV-11-10).
   */
  static async updateActivityStatus(tx, activityId, { targetStatus, dpiaStatus = null, legalException = null }) {
    const activity = await tx.findById('processing_register', activityId);
    if (!activity) throw new Error(`Processing activity ${activityId} not found`);

    if (targetStatus === COMPLIANCE_STATUSES.ACTIVE && activity.dpia_required) {
      const currentDpiaStatus = dpiaStatus || activity.dpia_status;
      if (currentDpiaStatus !== COMPLIANCE_STATUSES.APPROVED && !legalException) {
        const err = new Error('DPIA Gate Violation: Processing activity cannot become ACTIVE without an APPROVED DPIA (INV-11-10)');
        err.code = COMPLIANCE_ERRORS.DPIA_REQUIRED_NOT_APPROVED;
        throw err;
      }
    }

    return await tx.update('processing_register', activity.id, {
      status: targetStatus,
      dpia_status: dpiaStatus || activity.dpia_status,
      legal_exception: legalException,
      updated_at: new Date().toISOString()
    });
  }
}

module.exports = {
  ProcessingRegisterService,
  DEFAULT_RETAIL_ACTIVITIES
};
