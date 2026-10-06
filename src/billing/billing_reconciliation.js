/**
 * BoutiqFlow DZ — Billing Reconciliation Service (INV-12-21)
 * Audits provider transaction streams against internal invoices and subscriptions,
 * detecting discrepancies, lost webhooks, and reconciling missing records without double-charging.
 */

const { generateUUIDv7 } = require('../db/utils');
const { INVOICE_STATUSES, SUBSCRIPTION_STATUSES, PAYMENT_STATUSES } = require('./constants');
const { SubscriptionService } = require('./subscription_service');

class BillingReconciliationJob {
  /**
   * Reconciles external provider payments against internal invoice records (INV-12-21)
   */
  static async runReconciliation(tx, { providerRecords = [] }) {
    const tenantId = tx.session.tenantId;

    let missingPaymentsReconciled = 0;
    let duplicatePaymentsDetected = 0;
    let amountMismatchesDetected = 0;
    const discrepancies = [];

    for (const record of providerRecords) {
      const invoiceNumber = record.invoiceNumber;
      const providerAmount = BigInt(record.amountCents);
      const providerCurrency = (record.currency || 'DZD').toUpperCase();

      const invoices = await tx.query('invoices', i => i.tenant_id === tenantId && i.invoice_number === invoiceNumber);
      if (invoices.length === 0) {
        discrepancies.push({
          type: 'UNKNOWN_INVOICE_IN_PROVIDER',
          invoiceNumber,
          providerAmount
        });
        continue;
      }

      const invoice = invoices[0];
      const payments = await tx.query('payments', p => p.tenant_id === tenantId && p.invoice_id === invoice.id);

      // 1. Amount / Currency Mismatch
      if (providerAmount !== BigInt(invoice.total_cents) || providerCurrency !== invoice.currency) {
        amountMismatchesDetected++;
        discrepancies.push({
          type: 'AMOUNT_MISMATCH',
          invoiceId: invoice.id,
          expected: invoice.total_cents,
          actual: providerAmount
        });
        continue;
      }

      // 2. Duplicate Payment check
      if (payments.length > 1) {
        duplicatePaymentsDetected++;
        discrepancies.push({
          type: 'DUPLICATE_PAYMENT',
          invoiceId: invoice.id,
          paymentsCount: payments.length
        });
      }

      // 3. Missing payment recovery: Provider succeeded, but local invoice is still ISSUED (webhook was lost)
      if (payments.length === 0 && invoice.status !== INVOICE_STATUSES.PAID) {
        missingPaymentsReconciled++;

        // Reconcile and record payment
        const paymentRecord = {
          id: generateUUIDv7(),
          tenant_id: tenantId,
          invoice_id: invoice.id,
          payment_number: `PAY-RECON-${Date.now()}`,
          amount_cents: providerAmount,
          currency: providerCurrency,
          status: PAYMENT_STATUSES.SUCCEEDED,
          payment_method: 'RECONCILED_PROVIDER',
          provider: record.provider || 'CHARGILY',
          provider_payment_id: record.providerPaymentId || `ext_${Date.now()}`,
          created_at: new Date().toISOString()
        };
        await tx.insert('payments', paymentRecord);

        await tx.update('invoices', invoice.id, {
          status: INVOICE_STATUSES.PAID,
          paid_at: new Date().toISOString()
        });

        if (invoice.subscription_id) {
          await SubscriptionService.transitionStatus(tx, invoice.subscription_id, SUBSCRIPTION_STATUSES.ACTIVE, {
            reason: 'BILLING_RECONCILIATION_RECOVERY'
          });
        }
      }
    }

    return {
      status: 'COMPLETED',
      missingPaymentsReconciled,
      duplicatePaymentsDetected,
      amountMismatchesDetected,
      discrepanciesCount: discrepancies.length,
      discrepancies
    };
  }
}

module.exports = {
  BillingReconciliationJob,
  BillingReconciliationService: BillingReconciliationJob
};
