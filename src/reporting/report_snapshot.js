/**
 * BoutiqFlow DZ — Immutable Report Snapshot Service (INV-09-19)
 * Stores point-in-time cryptographic snapshots of month-end or audited reports.
 */

const crypto = require('node:crypto');
const { generateUUIDv7 } = require('../db/utils');
const { METRIC_VERSIONS } = require('./constants');

class ReportSnapshotService {
  /**
   * Computes deterministic SHA-256 hash of report data
   */
  static _computeHash(data) {
    const json = JSON.stringify(data, (key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value).sort().reduce((sorted, k) => {
          sorted[k] = value[k];
          return sorted;
        }, {});
      }
      return value;
    });
    return crypto.createHash('sha256').update(json).digest('hex');
  }

  /**
   * Creates an immutable point-in-time report snapshot
   */
  static async createSnapshot(tx, {
    reportType,
    period,
    data,
    generatedBy = 'system',
    definitionVersion = METRIC_VERSIONS.PROFIT
  }) {
    const tenantId = tx.session.tenantId;
    const snapshotId = generateUUIDv7();
    const dataHash = this._computeHash(data);

    const record = {
      id: snapshotId,
      snapshot_id: snapshotId,
      tenant_id: tenantId,
      report_type: reportType,
      period,
      definition_version: definitionVersion,
      data_hash: dataHash,
      data,
      generated_by: generatedBy,
      generated_at: new Date().toISOString()
    };

    const saved = await tx.insert('report_snapshots', record);

    // Record audit event
    await tx.insert('audit_logs', {
      action: 'REPORT_SNAPSHOT_CREATED',
      actor_id: generatedBy,
      entity_type: 'report_snapshot',
      entity_id: snapshotId,
      details: { reportType, period, definitionVersion, dataHash },
      created_at: new Date().toISOString()
    });

    return saved;
  }

  /**
   * Retrieves and verifies an existing snapshot by ID
   */
  static async getSnapshot(tx, snapshotId) {
    const tenantId = tx.session.tenantId;
    const snapshots = await tx.query('report_snapshots', s => s.tenant_id === tenantId && s.id === snapshotId);
    if (snapshots.length === 0) return null;

    const snap = snapshots[0];
    const currentHash = this._computeHash(snap.data);
    const isValid = currentHash === snap.data_hash;

    return {
      ...snap,
      isCryptographicallyValid: isValid
    };
  }
}

module.exports = {
  ReportSnapshotService
};
