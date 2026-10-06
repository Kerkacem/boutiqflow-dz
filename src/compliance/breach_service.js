/**
 * Incident & Breach Management Service
 * Implements Article 45 bis 8 of Algerian Law No. 18-07 as amended by Law No. 25-11.
 *
 * Requirements:
 * - Data Controller must notify ANPDP within a maximum of 5 days from becoming aware of a breach (INV-11-15).
 * - Late notification to authority requires documented delay justification (INV-11-16).
 * - Data Processor (BoutiqFlow) must notify Data Controller (Merchant) immediately (INV-11-14).
 * - High-risk breaches mandate plain-language notification to affected individuals (INV-11-17).
 * - Documented impact, corrective measures, and separate incident assessment workflow.
 */

const { generateUUIDv7 } = require('../db/utils');
const {
  SEVERITY_LEVELS
} = require('./constants');

class BreachManagementService {
  /**
   * Registers a discovered data security incident or breach.
   * Calculates the exact 5-day ANPDP regulatory notification deadline (INV-11-14, INV-11-15).
   */
  static async recordBreach(tx, {
    title,
    discoveredAt = new Date().toISOString(),
    knownAt = null,
    severity = SEVERITY_LEVELS.HIGH,
    compromisedDataCategories = [],
    estimatedAffectedCount = 0,
    rootCause,
    remediationSteps = '',
    source = 'INTERNAL_MONITORING'
  }) {
    if (!title || !rootCause) {
      throw new Error('Breach registration requires title and rootCause');
    }

    const tenantId = tx.session.tenantId;
    const effectiveKnownAt = knownAt || discoveredAt;
    const discoveryDate = new Date(effectiveKnownAt);

    // Law 25-11 Art. 45 bis 8: Exactly 5 days from becoming aware of breach
    const anpdpDeadline = new Date(discoveryDate.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();

    const record = {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      incident_title: title,
      discovered_at: discoveredAt,
      known_at: effectiveKnownAt,
      contained_at: null,
      severity,
      compromised_data_categories: compromisedDataCategories,
      estimated_affected_count: estimatedAffectedCount,
      root_cause: rootCause,
      remediation_steps: remediationSteps,
      notified_merchant_at: new Date().toISOString(), // Immediate processor-to-controller notice (INV-11-14)
      notified_anpdp_at: null,
      anpdp_deadline_at: anpdpDeadline,
      delay_justification: null,
      notified_subjects_at: null,
      is_resolved: false,
      source,
      created_at: new Date().toISOString()
    };

    await tx.insert('breach_register', record);
    return record;
  }

  /**
   * Logs regulatory notification to ANPDP, enforcing statutory delay justification (INV-11-15, INV-11-16).
   */
  static async recordAnpdpNotification(tx, breachId, { delayedReason = null, progressive = false } = {}) {
    const breach = await tx.findById('breach_register', breachId);
    if (!breach) {
      throw new Error(`Breach record ${breachId} not found`);
    }

    const now = new Date();
    const deadline = new Date(breach.anpdp_deadline_at);
    const isDelayed = now > deadline;

    // INV-11-16: Late notification strictly requires documented delay reason
    if (isDelayed && !delayedReason) {
      throw new Error('Notification is past the 5-day statutory deadline. Art. 45 bis 8 mandates stating reasons for delay.');
    }

    return await tx.update('breach_register', breachId, {
      notified_anpdp_at: now.toISOString(),
      delay_justification: isDelayed ? delayedReason : null,
      is_progressive_update: Boolean(progressive),
      is_resolved: !progressive,
      contained_at: breach.contained_at || now.toISOString()
    });
  }

  /**
   * Determines whether affected data subjects must be directly notified (INV-11-17).
   */
  static requiresDataSubjectNotification(breach) {
    return breach.severity === SEVERITY_LEVELS.HIGH || breach.severity === SEVERITY_LEVELS.CRITICAL;
  }

  /**
   * Formats a clear, plain-language notification draft for Algerian customers (Arabic & French) (INV-11-17).
   */
  static generateCustomerNotificationText(breach, boutiqueName = 'المحل') {
    return {
      ar: `إشعار هام من ${boutiqueName}: نود إعلامكم بحدوث واقعة أمنية تقنية تم احتواؤها فوراً، قد تكون شملت بعض بيانات التوصيل (مثل رقم الهاتف والعنوان). لقد اتخذنا التدابير اللازمة لتأمين بياناتكم وفقاً للقانون 18-07 المعدل بالقانون 25-11.`,
      fr: `Notification importante de ${boutiqueName}: Nous vous informons d'un incident de sécurité technique immédiatement circonscrit, ayant pu concerner certaines données de livraison. Les mesures de protection nécessaires ont été déployées conformément à la loi 18-07 modifiée par la loi 25-11.`
    };
  }

  /**
   * Records notification to affected data subjects
   */
  static async recordDataSubjectNotification(tx, breachId, { channel = 'SMS', recipientCount = 0 }) {
    const breach = await tx.findById('breach_register', breachId);
    if (!breach) throw new Error(`Breach record ${breachId} not found`);

    return await tx.update('breach_register', breachId, {
      notified_subjects_at: new Date().toISOString(),
      subject_notification_channel: channel,
      subject_notification_count: recipientCount
    });
  }

  /**
   * Evaluates whether a generic Security Incident constitutes a Personal Data Breach (Section 35)
   */
  static async assessSecurityIncident(tx, { incidentTitle, affectedAssets = [], involvesPersonalData = false, piiCategories = [] }) {
    const tenantId = tx.session.tenantId;
    const incidentId = generateUUIDv7();

    const incident = {
      id: incidentId,
      tenant_id: tenantId,
      title: incidentTitle,
      affected_assets: affectedAssets,
      involves_personal_data: involvesPersonalData,
      is_data_breach: involvesPersonalData,
      status: 'ASSESSED',
      created_at: new Date().toISOString()
    };

    await tx.insert('security_incidents', incident);

    if (involvesPersonalData) {
      // Escalate to Data Breach register
      const breach = await this.recordBreach(tx, {
        title: `Escalated from Incident: ${incidentTitle}`,
        severity: piiCategories.includes('FINANCIAL') ? SEVERITY_LEVELS.CRITICAL : SEVERITY_LEVELS.HIGH,
        compromisedDataCategories: piiCategories,
        rootCause: `Security incident on ${affectedAssets.join(', ')}`,
        source: 'SECURITY_INCIDENT_ESCALATION'
      });
      return { incident, isDataBreach: true, breachRecord: breach };
    }

    return { incident, isDataBreach: false, breachRecord: null };
  }
}

module.exports = {
  BreachManagementService,
  SEVERITY_LEVELS
};
