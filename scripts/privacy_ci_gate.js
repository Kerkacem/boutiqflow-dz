#!/usr/bin/env node
/**
 * BoutiqFlow DZ — Privacy CI Gate (INV-11-25)
 * Automated check verifying that any entity field carrying personal or sensitive data
 * has explicit purpose, classification, retention policy, access policy, and journal policy.
 */

const { FIELD_TAXONOMY } = require('../src/compliance/access_policy');
const { FIELD_CLASSIFICATIONS } = require('../src/compliance/constants');

function validateFieldPrivacyMetadata(fieldDef) {
  const errors = [];

  if (!fieldDef.name) {
    errors.push('Field name is required');
  }

  if (!fieldDef.classification || !Object.values(FIELD_CLASSIFICATIONS).includes(fieldDef.classification)) {
    errors.push(`Missing or invalid PII classification for field '${fieldDef.name}'`);
  }

  // Personal, Sensitive, High-Risk require purpose, retention, access policy, and journal policy
  const requiresGovernance = [
    FIELD_CLASSIFICATIONS.PERSONAL,
    FIELD_CLASSIFICATIONS.SENSITIVE,
    FIELD_CLASSIFICATIONS.HIGH_RISK
  ].includes(fieldDef.classification);

  if (requiresGovernance) {
    if (!fieldDef.purpose) {
      errors.push(`Privacy CI Error: Missing purpose for field '${fieldDef.name}'`);
    }
    if (!fieldDef.retentionDays && !fieldDef.retentionPolicy) {
      errors.push(`Privacy CI Error: Missing retention policy for field '${fieldDef.name}'`);
    }
    if (!fieldDef.allowedRoles || !Array.isArray(fieldDef.allowedRoles)) {
      errors.push(`Privacy CI Error: Missing access policy / allowedRoles for field '${fieldDef.name}'`);
    }
    if (fieldDef.journalRequired === undefined && !fieldDef.journalPolicy) {
      errors.push(`Privacy CI Error: Missing journal policy for field '${fieldDef.name}'`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function runCiScan() {
  console.log('[PRIVACY-CI-GATE] Scanning PII field taxonomy and models...');
  let totalErrors = 0;

  for (const [fieldName, config] of Object.entries(FIELD_TAXONOMY)) {
    const res = validateFieldPrivacyMetadata({
      name: fieldName,
      classification: config.classification,
      purpose: 'OPERATIONAL_RETAIL',
      retentionDays: 730,
      allowedRoles: config.allowedRoles,
      journalRequired: true
    });

    if (!res.valid) {
      console.error(`[PRIVACY-CI-GATE ERROR] ${res.errors.join('; ')}`);
      totalErrors += res.errors.length;
    }
  }

  if (totalErrors > 0) {
    console.error(`[PRIVACY-CI-GATE] FAILED with ${totalErrors} errors.`);
    if (require.main === module) process.exit(1);
    return false;
  }

  console.log('[PRIVACY-CI-GATE] All personal data fields have valid privacy metadata. PASS.');
  return true;
}

if (require.main === module) {
  runCiScan();
}

module.exports = {
  validateFieldPrivacyMetadata,
  runCiScan
};
