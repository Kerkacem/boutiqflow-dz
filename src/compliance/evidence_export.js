/**
 * BoutiqFlow DZ — Compliance Evidence Export & Audit Pack Service (INV-11-21, INV-11-26)
 * Generates cryptographically hashed, immutable compliance evidence packages
 * for statutory ANPDP audits, regulatory inspections, and supervisory reviews.
 */

const crypto = require('crypto');
const { generateUUIDv7 } = require('../db/utils');
const { ProcessingJournalService } = require('./processing_journal');
const {
  PROCESSING_OPERATIONS,
  COMPLIANCE_ERRORS
} = require('./constants');

class ComplianceEvidenceService {
  /**
   * Generates a comprehensive, auditable Compliance Evidence Package (INV-11-26)
   */
  static async generateEvidencePack(tx, {
    actorRole = 'OWNER',
    generatedBy = null
  } = {}) {
    // 1. Permission check: Only OWNER, MANAGER, or DPO can generate compliance exports (INV-11-21)
    const allowedRoles = ['OWNER', 'MANAGER', 'DPO'];
    if (!allowedRoles.includes(actorRole)) {
      const err = new Error(`Unauthorized Export: Role '${actorRole}' is forbidden from exporting compliance evidence (INV-11-21)`);
      err.code = COMPLIANCE_ERRORS.UNAUTHORIZED_EXPORT;
      throw err;
    }

    const tenantId = tx.session.tenantId;

    // 2. Aggregate compliance artifacts
    const processingActivities = await tx.query('processing_register', a => a.tenant_id === tenantId);
    const journalEntries = await tx.query('processing_journal', j => j.tenant_id === tenantId);
    const breaches = await tx.query('breach_register', b => b.tenant_id === tenantId);
    const dpias = await tx.query('dpia_records', d => d.tenant_id === tenantId);
    const transfers = await tx.query('transfer_records', t => t.tenant_id === tenantId);
    const subprocessors = await tx.query('subprocessors', s => s.tenant_id === tenantId);
    const dpaRecords = await tx.query('dpa_records', d => d.tenant_id === tenantId);
    const privacyRequests = await tx.query('privacy_requests', p => p.tenant_id === tenantId);
    const retentionPolicies = await tx.query('retention_policies', r => r.tenant_id === tenantId);
    const legalHolds = await tx.query('legal_holds', l => l.tenant_id === tenantId);

    const generatedAt = new Date().toISOString();
    const exportId = generateUUIDv7();

    const rawPack = {
      tenantId,
      exportId,
      definitionVersion: 'v1.0-LAW2511',
      generatedAt,
      processingActivitiesCount: processingActivities.length,
      journalEntriesCount: journalEntries.length,
      breachesCount: breaches.length,
      dpiasCount: dpias.length,
      transfersCount: transfers.length,
      subprocessorsCount: subprocessors.length,
      dpaRecordsCount: dpaRecords.length,
      privacyRequestsCount: privacyRequests.length,
      retentionPoliciesCount: retentionPolicies.length,
      legalHoldsCount: legalHolds.length,
      data: {
        processingActivities,
        breaches,
        dpias,
        transfers,
        subprocessors,
        dpaRecords,
        privacyRequests,
        retentionPolicies,
        legalHolds
      }
    };

    // 3. Cryptographic integrity hash
    const packString = JSON.stringify(rawPack, (k, v) => typeof v === 'bigint' ? v.toString() : v);
    const dataHash = crypto.createHash('sha256').update(packString).digest('hex');

    const exportRecord = {
      id: exportId,
      tenant_id: tenantId,
      definition_version: 'v1.0-LAW2511',
      data_hash: dataHash,
      generated_by: generatedBy || tx.session.userId || 'compliance_officer',
      actor_role: actorRole,
      created_at: generatedAt
    };

    // Store in immutable compliance_evidence_exports table
    await tx.insert('compliance_evidence_exports', exportRecord);

    // 4. Log statutory export event in processing_journal (INV-11-21)
    await ProcessingJournalService.logOperation(tx, {
      actorId: generatedBy || tx.session.userId || 'compliance_officer',
      actorRole,
      operation: PROCESSING_OPERATIONS.EXTRACTED,
      purpose: 'COMPLIANCE_EVIDENCE_EXPORT',
      referenceType: 'EVIDENCE_PACK',
      referenceId: exportId,
      details: {
        exportId,
        dataHash,
        activitiesCount: processingActivities.length,
        journalCount: journalEntries.length
      }
    });

    return {
      exportId,
      definitionVersion: 'v1.0-LAW2511',
      dataHash,
      generatedAt,
      summary: rawPack
    };
  }
}

module.exports = {
  ComplianceEvidenceService
};
