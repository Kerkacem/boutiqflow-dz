/**
 * BoutiqFlow DZ — Data Protection Impact Assessment (DPIA) Subsystem
 * Implements Article 41 bis 1 of Algerian Law No. 18-07 as amended by Law No. 25-11.
 *
 * Provides structured, deterministic risk assessments, mitigation tracking,
 * and approval gates before high-risk processing operations become active.
 */

const { generateUUIDv7 } = require('../db/utils');
const {
  COMPLIANCE_STATUSES,
  SEVERITY_LEVELS
} = require('./constants');

class DpiAService {
  /**
   * Calculates deterministic risk score and classification (Section 27)
   */
  static calculateRiskScore(likelihood, severity) {
    const l = Math.max(1, Math.min(4, parseInt(likelihood || 1, 10)));
    const s = Math.max(1, Math.min(4, parseInt(severity || 1, 10)));
    const score = l * s;

    let riskLevel = SEVERITY_LEVELS.LOW;
    if (score >= 12) riskLevel = SEVERITY_LEVELS.CRITICAL;
    else if (score >= 8) riskLevel = SEVERITY_LEVELS.HIGH;
    else if (score >= 4) riskLevel = SEVERITY_LEVELS.MEDIUM;

    return {
      likelihood: l,
      severity: s,
      score,
      riskLevel
    };
  }

  /**
   * Initializes a DPIA study for a high-risk processing activity
   */
  static async createDpia(tx, {
    processingActivityId,
    title,
    description,
    scope,
    context,
    risks = []
  }) {
    if (!processingActivityId || !title) {
      throw new Error('DPIA requires processingActivityId and title');
    }

    const tenantId = tx.session.tenantId;
    const dpiaId = generateUUIDv7();

    const assessedRisks = risks.map(r => {
      const scoring = this.calculateRiskScore(r.likelihood, r.severity);
      return {
        id: generateUUIDv7(),
        title: r.title || 'Identified Privacy Risk',
        description: r.description || '',
        likelihood: scoring.likelihood,
        severity: scoring.severity,
        score: scoring.score,
        riskLevel: scoring.riskLevel,
        mitigation: r.mitigation || 'TECHNICAL_ACCESS_CONTROL',
        residualRisk: r.residualRisk || SEVERITY_LEVELS.LOW
      };
    });

    const dpiaRecord = {
      id: dpiaId,
      tenant_id: tenantId,
      processing_activity_id: processingActivityId,
      title,
      description: description || '',
      scope: scope || 'STORE_AND_ONLINE',
      context: context || '',
      status: COMPLIANCE_STATUSES.IN_PROGRESS,
      risks: assessedRisks,
      reviewed_by: null,
      reviewed_at: null,
      review_notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await tx.insert('dpia_records', dpiaRecord);

    // Update processing activity to reflect DPIA in progress
    const activity = await tx.findById('processing_register', processingActivityId);
    if (activity) {
      await tx.update('processing_register', activity.id, {
        dpia_status: COMPLIANCE_STATUSES.IN_PROGRESS,
        updated_at: new Date().toISOString()
      });
    }

    return dpiaRecord;
  }

  /**
   * Approves a DPIA after verifying mitigations, unlocking the activity gate (INV-11-10)
   */
  static async approveDpia(tx, dpiaId, {
    approverId = null,
    approverRole = 'DPO',
    reviewNotes = 'All high-risk findings mitigated to acceptable levels.'
  } = {}) {
    const dpia = await tx.findById('dpia_records', dpiaId);
    if (!dpia) throw new Error(`DPIA ${dpiaId} not found`);

    const updated = await tx.update('dpia_records', dpia.id, {
      status: COMPLIANCE_STATUSES.APPROVED,
      reviewed_by: approverId || tx.session.userId || 'compliance_dpo',
      reviewed_at: new Date().toISOString(),
      review_notes: reviewNotes,
      updated_at: new Date().toISOString()
    });

    // Automatically update processing register activity status
    const activity = await tx.findById('processing_register', dpia.processing_activity_id);
    if (activity) {
      await tx.update('processing_register', activity.id, {
        dpia_status: COMPLIANCE_STATUSES.APPROVED,
        status: COMPLIANCE_STATUSES.ACTIVE, // Can now safely transition to ACTIVE
        updated_at: new Date().toISOString()
      });
    }

    return updated;
  }

  /**
   * Rejects a DPIA due to unmitigated high risks
   */
  static async rejectDpia(tx, dpiaId, reason) {
    const dpia = await tx.findById('dpia_records', dpiaId);
    if (!dpia) throw new Error(`DPIA ${dpiaId} not found`);

    const updated = await tx.update('dpia_records', dpia.id, {
      status: COMPLIANCE_STATUSES.REJECTED,
      reviewed_by: tx.session.userId || 'compliance_dpo',
      reviewed_at: new Date().toISOString(),
      review_notes: reason,
      updated_at: new Date().toISOString()
    });

    const activity = await tx.findById('processing_register', dpia.processing_activity_id);
    if (activity) {
      await tx.update('processing_register', activity.id, {
        dpia_status: COMPLIANCE_STATUSES.REJECTED,
        status: COMPLIANCE_STATUSES.SUSPENDED,
        updated_at: new Date().toISOString()
      });
    }

    return updated;
  }
}

module.exports = {
  DpiAService
};
