/**
 * BoutiqFlow DZ — PostgreSQL Patch & CVE Validator (INV-13-01, Requirement 8)
 * Validates database version against CVE-2026-14666 (RLS policy caching vulnerability).
 * Fails CI/Gate 13 if production database version is vulnerable without documented mitigation.
 */

const { SECURITY_ERRORS } = require('./constants');

// Safe threshold versions patched against CVE-2026-14666
const SAFE_MINIMUM_VERSIONS = {
  18: 6,   // 18.6+
  17: 11,  // 17.11+
  16: 15,  // 16.15+
  15: 19,  // 15.19+
  14: 24   // 14.24+
};

class PostgresPatchValidator {
  /**
   * Parses PostgreSQL version string and determines CVE-2026-14666 vulnerability
   */
  static isVulnerableToCVE2026_14666(versionString) {
    if (!versionString) return true;

    // Matches '16.14', 'PostgreSQL 17.10 on x86_64', etc.
    const match = versionString.match(/(?:PostgreSQL\s+)?(\d+)\.(\d+)/i);
    if (!match) return true;

    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);

    const safeMinor = SAFE_MINIMUM_VERSIONS[major];
    if (safeMinor === undefined) {
      // If version is >= 19, assume safe; if < 14, definitely vulnerable
      return major < 14;
    }

    return minor < safeMinor;
  }

  /**
   * Validates database deployment environment for production readiness
   */
  static validateDatabaseEnvironment(versionString, { hasDocumentedMitigation = false, forceRlsEnabled = true } = {}) {
    const isVulnerable = this.isVulnerableToCVE2026_14666(versionString);

    if (isVulnerable && !hasDocumentedMitigation) {
      const err = new Error(
        `Critical Security Blocker: PostgreSQL version '${versionString}' is vulnerable to CVE-2026-14666 (RLS policy caching). ` +
        `Upgrade to at least PostgreSQL 18.6, 17.11, 16.15, 15.19, or 14.24 to ensure stale RLS policies are purged (INV-13-01).`
      );
      err.code = SECURITY_ERRORS.DATABASE_VULNERABLE;
      err.cve = 'CVE-2026-14666';
      err.detectedVersion = versionString;
      throw err;
    }

    if (!forceRlsEnabled) {
      const err = new Error('Database Security Violation: FORCE ROW LEVEL SECURITY must be enabled across all multi-tenant tables');
      err.code = 'FORCE_RLS_REQUIRED';
      throw err;
    }

    return {
      status: 'VERIFIED_SAFE',
      detectedVersion: versionString,
      isPatched: !isVulnerable,
      hasMitigation: hasDocumentedMitigation,
      forceRlsEnabled: true
    };
  }
}

module.exports = {
  PostgresPatchValidator,
  SAFE_MINIMUM_VERSIONS
};
