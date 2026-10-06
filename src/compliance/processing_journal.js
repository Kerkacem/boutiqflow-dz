/**
 * Automated Processing Journal (Carnet automatisé des opérations)
 * Implements Article 41 bis 3 of Algerian Law No. 18-07 as amended by Law No. 25-11.
 *
 * Automatically records every operation on personal data (collection, consultation,
 * modification, extraction, disclosure, transfer, deletion) with actor identity,
 * timestamp, purpose, and cryptographic chaining to detect tampering or gaps.
 */

const crypto = require('crypto');
const { generateUUIDv7 } = require('../db/utils');
const {
  PROCESSING_OPERATIONS,
  COMPLIANCE_ERRORS
} = require('./constants');

class ProcessingJournalService {
  /**
   * Computes SHA-256 hash for cryptographic audit chaining (INV-11-06, INV-11-07)
   */
  static computeEventHash({ tenantId, sequence, timestamp, operation, purpose, actorId, dataSubjectId, details, previousEventHash }) {
    const payload = JSON.stringify({
      tenantId,
      sequence,
      timestamp,
      operation,
      purpose,
      actorId,
      dataSubjectId: String(dataSubjectId || ''),
      details: details || {},
      previousEventHash: previousEventHash || 'GENESIS'
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Logs an automated personal data processing operation with cryptographic sequence chaining.
   */
  static async logOperation(tx, {
    actorId,
    actorRole = 'UNKNOWN',
    operation,
    dataSubjectType = 'CUSTOMER',
    dataSubjectId = null,
    purpose,
    source = 'INTERNAL',
    destination = null,
    recipient = null,
    referenceType = null,
    referenceId = null,
    ipAddress = null,
    userAgent = null,
    details = {}
  }) {
    if (!actorId || !operation || !purpose) {
      throw new Error('Processing journal entry requires actorId, operation, and purpose (INV-11-05)');
    }

    const opKey = String(operation).toUpperCase();
    if (!PROCESSING_OPERATIONS[opKey] && !Object.values(PROCESSING_OPERATIONS).includes(opKey)) {
      throw new Error(`Invalid processing operation: ${operation}`);
    }

    const canonicalOp = PROCESSING_OPERATIONS[opKey] || opKey;
    const tenantId = tx.session.tenantId;

    // Fetch existing entries to calculate sequence and previous hash
    const existing = await tx.query('processing_journal', e => e.tenant_id === tenantId);
    existing.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

    const lastEntry = existing[existing.length - 1];
    const sequence = (lastEntry && lastEntry.sequence ? lastEntry.sequence : existing.length) + 1;
    const previousEventHash = lastEntry && lastEntry.event_hash ? lastEntry.event_hash : 'GENESIS';

    const timestamp = new Date().toISOString();
    const eventHash = this.computeEventHash({
      tenantId,
      sequence,
      timestamp,
      operation: canonicalOp,
      purpose,
      actorId,
      dataSubjectId,
      details,
      previousEventHash
    });

    const entryRecord = {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      sequence,
      operation: canonicalOp,
      purpose,
      actor_id: actorId,
      actor_role: actorRole,
      data_subject_type: dataSubjectType,
      data_subject_id: String(dataSubjectId || ''),
      source,
      destination,
      recipient,
      reference_type: referenceType,
      reference_id: referenceId,
      ip_address: ipAddress,
      user_agent: userAgent,
      details,
      previous_event_hash: previousEventHash,
      event_hash: eventHash,
      created_at: timestamp
    };

    return await tx.insert('processing_journal', entryRecord);
  }

  /**
   * Appends a correction event without modifying original historical journal entry (INV-11-06)
   */
  static async logCorrection(tx, {
    originalEntryId,
    actorId,
    actorRole = 'MANAGER',
    reason,
    correctedDetails = {}
  }) {
    const original = await tx.findById('processing_journal', originalEntryId);
    if (!original) {
      throw new Error(`Original journal entry ${originalEntryId} not found`);
    }

    return await this.logOperation(tx, {
      actorId,
      actorRole,
      operation: PROCESSING_OPERATIONS.MODIFIED,
      dataSubjectType: original.data_subject_type,
      dataSubjectId: original.data_subject_id,
      purpose: 'JOURNAL_CORRECTION',
      referenceType: 'PROCESSING_JOURNAL',
      referenceId: originalEntryId,
      details: {
        originalEntryId,
        reason,
        correctedDetails
      }
    });
  }

  /**
   * Verifies cryptographic chain and sequence integrity of the processing journal (INV-11-07)
   */
  static async verifyJournalIntegrity(tx, targetTenantId = null) {
    const tenantId = targetTenantId || tx.session.tenantId;
    const entries = await tx.query('processing_journal', e => e.tenant_id === tenantId);

    if (entries.length === 0) {
      return { valid: true, count: 0 };
    }

    entries.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

    let expectedPrevHash = 'GENESIS';

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const expectedSequence = i + 1;

      // 1. Sequence Gap Check
      if (entry.sequence !== expectedSequence) {
        return {
          valid: false,
          error: COMPLIANCE_ERRORS.JOURNAL_SEQUENCE_GAP,
          sequence: entry.sequence,
          expectedSequence,
          message: `Sequence gap detected: expected ${expectedSequence}, found ${entry.sequence}`
        };
      }

      // 2. Previous Hash Chain Check
      if (entry.previous_event_hash !== expectedPrevHash) {
        return {
          valid: false,
          error: COMPLIANCE_ERRORS.JOURNAL_HASH_MISMATCH,
          sequence: entry.sequence,
          expectedPreviousHash: expectedPrevHash,
          actualPreviousHash: entry.previous_event_hash,
          message: `Hash chain broken at sequence ${entry.sequence}`
        };
      }

      // 3. Recompute Hash Check
      const recomputedHash = this.computeEventHash({
        tenantId,
        sequence: entry.sequence,
        timestamp: entry.created_at,
        operation: entry.operation,
        purpose: entry.purpose,
        actorId: entry.actor_id,
        dataSubjectId: entry.data_subject_id,
        details: entry.details,
        previousEventHash: entry.previous_event_hash
      });

      if (entry.event_hash !== recomputedHash) {
        return {
          valid: false,
          error: COMPLIANCE_ERRORS.JOURNAL_TAMPER_DETECTED,
          sequence: entry.sequence,
          storedHash: entry.event_hash,
          recomputedHash,
          message: `Tamper detected at sequence ${entry.sequence}: payload hash mismatch`
        };
      }

      expectedPrevHash = entry.event_hash;
    }

    return { valid: true, count: entries.length };
  }

  /**
   * Queries the journal for supervisory compliance auditing.
   */
  static async queryJournal(tx, filter = {}) {
    return await tx.query('processing_journal', entry => {
      if (filter.operation && entry.operation !== filter.operation && entry.operation !== PROCESSING_OPERATIONS[filter.operation]) return false;
      if (filter.dataSubjectId && entry.data_subject_id !== String(filter.dataSubjectId)) return false;
      if (filter.actorId && entry.actor_id !== filter.actorId) return false;
      if (filter.purpose && entry.purpose !== filter.purpose) return false;
      return true;
    });
  }
}

module.exports = {
  ProcessingJournalService,
  PROCESSING_OPERATIONS
};
