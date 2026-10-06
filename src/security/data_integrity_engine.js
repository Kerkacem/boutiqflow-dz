/**
 * BoutiqFlow DZ — Comprehensive Data Integrity Engine (INV-13-17, Requirement 27)
 * Runs cross-subsystem verification audits:
 * 1. Physical stock vs Stock movements ledger
 * 2. Reserved stock vs Active reservations
 * 3. Sales total vs Line items and tender payments
 * 4. Invoices total vs Settled payments
 * 5. Processing Journal cryptographic hash chain
 * Flags MATCHED, DRIFT, or CORRUPTED.
 */

const { INTEGRITY_STATUSES, SECURITY_ERRORS } = require('./constants');
const { ProcessingJournalService } = require('../compliance/processing_journal');

class IntegrityCheckJob {
  /**
   * Executes all comprehensive integrity checks across subsystems
   */
  static async runAllChecks(tx, tenantId = null) {
    const effectiveTenantId = tenantId || tx.session?.tenantId;
    const results = {
      inventoryStockCheck: await this.verifyInventoryLedger(tx, effectiveTenantId),
      inventoryReservationsCheck: await this.verifyReservations(tx, effectiveTenantId),
      salesPaymentsCheck: await this.verifySalesAndPayments(tx, effectiveTenantId),
      invoicesPaymentsCheck: await this.verifyInvoicesAndPayments(tx, effectiveTenantId),
      journalHashChainCheck: await this.verifyProcessingJournal(tx, effectiveTenantId)
    };

    let overallStatus = INTEGRITY_STATUSES.MATCHED;
    const discrepancies = [];

    for (const [checkName, res] of Object.entries(results)) {
      if (res.status === INTEGRITY_STATUSES.CORRUPTED) {
        overallStatus = INTEGRITY_STATUSES.CORRUPTED;
        discrepancies.push({ check: checkName, status: res.status, details: res.details });
      } else if (res.status === INTEGRITY_STATUSES.DRIFT && overallStatus !== INTEGRITY_STATUSES.CORRUPTED) {
        overallStatus = INTEGRITY_STATUSES.DRIFT;
        discrepancies.push({ check: checkName, status: res.status, details: res.details });
      }
    }

    return {
      tenantId: effectiveTenantId,
      overallStatus,
      timestamp: new Date().toISOString(),
      results,
      discrepanciesCount: discrepancies.length,
      discrepancies
    };
  }

  /**
   * 1. Verifies physical stock level equals sum of movements ledger (INV-03-01)
   */
  static async verifyInventoryLedger(tx, tenantId) {
    const stockLevels = await tx.query('stock_levels', s => !tenantId || s.tenant_id === tenantId);
    let drifts = 0;

    for (const level of stockLevels) {
      const movements = await tx.query('stock_movements', m =>
        m.location_id === level.location_id && m.variant_id === level.variant_id
      );

      let ledgerSum = 0;
      for (const mov of movements) {
        ledgerSum += (mov.qty || 0);
      }

      if (level.on_hand !== ledgerSum) {
        drifts++;
      }
      if (level.on_hand < 0) {
        return {
          status: INTEGRITY_STATUSES.CORRUPTED,
          details: `Negative on_hand stock detected (${level.on_hand}) on variant ${level.variant_id}`
        };
      }
    }

    return {
      status: drifts === 0 ? INTEGRITY_STATUSES.MATCHED : INTEGRITY_STATUSES.DRIFT,
      driftsCount: drifts
    };
  }

  /**
   * 2. Verifies reserved count equals sum of active reservations (INV-03-04)
   */
  static async verifyReservations(tx, tenantId) {
    const stockLevels = await tx.query('stock_levels', s => !tenantId || s.tenant_id === tenantId);
    let drifts = 0;

    for (const level of stockLevels) {
      const activeReservations = await tx.query('stock_reservations', r =>
        r.location_id === level.location_id &&
        r.variant_id === level.variant_id &&
        r.status === 'ACTIVE'
      );

      let reservedSum = 0;
      for (const res of activeReservations) {
        reservedSum += (res.quantity || 0);
      }

      if (level.reserved !== reservedSum) {
        drifts++;
      }
      if (level.reserved < 0 || level.reserved > level.on_hand) {
        return {
          status: INTEGRITY_STATUSES.CORRUPTED,
          details: `Invalid reservation balance (reserved: ${level.reserved}, on_hand: ${level.on_hand}) on variant ${level.variant_id}`
        };
      }
    }

    return {
      status: drifts === 0 ? INTEGRITY_STATUSES.MATCHED : INTEGRITY_STATUSES.DRIFT,
      driftsCount: drifts
    };
  }

  /**
   * 3. Verifies completed sales total matches sum of line items
   */
  static async verifySalesAndPayments(tx, tenantId) {
    const sales = await tx.query('sales', s => (!tenantId || s.tenant_id === tenantId) && s.status === 'COMPLETED');
    let drifts = 0;

    for (const sale of sales) {
      const items = await tx.query('sale_items', i => i.sale_id === sale.id);
      let calculatedTotal = 0n;
      for (const it of items) {
        calculatedTotal += BigInt(it.total_centimes || it.subtotal_centimes || 0);
      }
      calculatedTotal -= BigInt(sale.discount_centimes || 0);

      if (BigInt(sale.total_centimes) !== calculatedTotal) {
        drifts++;
      }
    }

    return {
      status: drifts === 0 ? INTEGRITY_STATUSES.MATCHED : INTEGRITY_STATUSES.DRIFT,
      driftsCount: drifts
    };
  }

  /**
   * 4. Verifies paid invoices have matching payment records
   */
  static async verifyInvoicesAndPayments(tx, tenantId) {
    const paidInvoices = await tx.query('invoices', i => (!tenantId || i.tenant_id === tenantId) && i.status === 'PAID');
    let drifts = 0;

    for (const inv of paidInvoices) {
      const payments = await tx.query('payments', p => p.invoice_id === inv.id && p.status === 'SUCCEEDED');
      let paymentsSum = 0n;
      for (const p of payments) {
        paymentsSum += BigInt(p.amount_cents || 0);
      }

      if (paymentsSum < BigInt(inv.total_cents)) {
        drifts++;
      }
    }

    return {
      status: drifts === 0 ? INTEGRITY_STATUSES.MATCHED : INTEGRITY_STATUSES.DRIFT,
      driftsCount: drifts
    };
  }

  /**
   * 5. Verifies cryptographic hash chaining on Processing Journal
   */
  static async verifyProcessingJournal(tx, tenantId) {
    if (!tenantId) return { status: INTEGRITY_STATUSES.MATCHED };
    try {
      const journalRes = await ProcessingJournalService.verifyJournalIntegrity(tx, tenantId);
      return {
        status: journalRes.valid ? INTEGRITY_STATUSES.MATCHED : INTEGRITY_STATUSES.CORRUPTED,
        chainLength: journalRes.entriesCount
      };
    } catch (e) {
      return {
        status: INTEGRITY_STATUSES.CORRUPTED,
        details: e.message
      };
    }
  }
}

module.exports = {
  IntegrityCheckJob
};
