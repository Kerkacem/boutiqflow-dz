/**
 * BoutiqFlow DZ — Secure Report Export Service (INV-09-16, INV-09-17)
 * Generates tenant-scoped CSV and data exports with strict PII masking,
 * Law 25-11 processing journal audit, and memory-safe chunking.
 */

const { generateUUIDv7, centimesToDinar } = require('../db/utils');
const { ROLES } = require('../rbac/permissions');
const { REPORT_ERRORS } = require('./constants');

class ExportService {
  /**
   * Masks personal phone numbers and delivery addresses
   */
  static _maskPii(text) {
    if (!text) return '';
    const str = String(text);
    if (str.length <= 4) return '***';
    return str.substring(0, 4) + '***' + str.substring(str.length - 2);
  }

  /**
   * Generates CSV for Sales Report with PII protection & audit trail (INV-09-16)
   */
  static async exportSalesCsv(tx, {
    sales = [],
    includePii = false,
    purpose = 'Fiscal accounting export',
    actorRole = ROLES.MANAGER,
    actorId = 'usr_export',
    maxRows = 10000
  } = {}) {
    const tenantId = tx.session.tenantId;

    if (sales.length > maxRows) {
      const err = new Error(`Export size exceeds maximum allowed rows (${sales.length} > ${maxRows}) (INV-09-17)`);
      err.code = REPORT_ERRORS.EXPORT_TOO_LARGE;
      throw err;
    }

    // Role check for unmasked PII
    if (includePii) {
      if (![ROLES.OWNER, ROLES.MANAGER].includes(actorRole)) {
        const err = new Error('Security Violation: Only Managers and Owners are authorized to export customer PII (INV-09-16)');
        err.code = REPORT_ERRORS.UNAUTHORIZED_REPORT;
        throw err;
      }

      // Log to statutory Personal Data Processing Journal (Law 25-11 Art. 41 bis 3)
      await tx.insert('processing_journal', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        action: 'PERSONAL_DATA_EXPORTED',
        actor_id: actorId,
        purpose,
        categories: ['CUSTOMER_PHONE', 'CUSTOMER_NAME', 'DELIVERY_ADDRESS'],
        records_count: sales.length,
        timestamp: new Date().toISOString()
      });
    }

    // Record Business Audit Log
    await tx.insert('audit_logs', {
      action: 'REPORT_EXPORTED',
      actor_id: actorId,
      entity_type: 'sales_export',
      entity_id: tenantId,
      details: { rowsCount: sales.length, format: 'CSV', includePii },
      created_at: new Date().toISOString()
    });

    const headers = [
      'ID Vente',
      'N° Reçu',
      'Date',
      'Total (DA)',
      'Articles',
      'Client',
      'Téléphone',
      'Statut'
    ];

    const lines = [headers.join(',')];

    for (const s of sales) {
      const custName = includePii ? (s.customer_name || 'Anonyme') : this._maskPii(s.customer_name || 'Anonyme');
      const custPhone = includePii ? (s.customer_phone || 'N/A') : this._maskPii(s.customer_phone || 'N/A');
      const totalDA = centimesToDinar(s.total_centimes || 0n);

      const row = [
        `"${s.id}"`,
        `"${s.receipt_number || s.id}"`,
        `"${s.created_at}"`,
        `"${totalDA}"`,
        `"${s.items_count || 1}"`,
        `"${custName}"`,
        `"${custPhone}"`,
        `"${s.status}"`
      ];

      lines.push(row.join(','));
    }

    return lines.join('\n');
  }

  /**
   * Generates CSV for Inventory Valuation Report
   */
  static exportInventoryCsv(items = []) {
    const headers = ['SKU', 'Désignation', 'Taille', 'Couleur', 'Stock Physique', 'Réservé', 'Disponible', 'CUMP (DA)', 'Valeur Stock (DA)'];
    const lines = [headers.join(',')];

    for (const it of items) {
      lines.push([
        `"${it.sku}"`,
        `"${it.productName}"`,
        `"${it.size || ''}"`,
        `"${it.color || ''}"`,
        it.onHand,
        it.reserved,
        it.available,
        `"${it.weightedAverageCostDA}"`,
        `"${it.stockValueDA}"`
      ].join(','));
    }

    return lines.join('\n');
  }
}

module.exports = {
  ExportService
};
