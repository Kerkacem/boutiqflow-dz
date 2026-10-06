/**
 * BoutiqFlow DZ — Invoice Service & Immutability Subsystem (INV-12-04, INV-12-05)
 * Manages commercial customer invoices, monotonic numbering, and immutable financial snapshots.
 * Corrections are handled strictly via Credit Notes or formal voiding.
 */

const { generateUUIDv7 } = require('../db/utils');
const { INVOICE_STATUSES, BILLING_ERRORS } = require('./constants');

class InvoiceService {
  /**
   * Generates a monotonic, tenant-scoped invoice number (e.g. BF-2026-000001)
   */
  static async generateInvoiceNumber(tx, tenantId) {
    const existing = await tx.query('invoices', i => i.tenant_id === tenantId);
    const count = existing.length + 1;
    const year = new Date().getFullYear();
    const padded = String(count).padStart(6, '0');
    return `BF-${year}-${padded}`;
  }

  /**
   * Issues an immutable invoice (INV-12-04)
   */
  static async createInvoice(tx, {
    billingAccountId = null,
    subscriptionId = null,
    planVersionId,
    lines = [],
    notes = '',
    currency = 'DZD',
    taxCents = 0n,
    discountCents = 0n
  }) {
    const tenantId = tx.session.tenantId;
    const invoiceId = generateUUIDv7();
    const invoiceNumber = await this.generateInvoiceNumber(tx, tenantId);

    // Calculate subtotal from lines
    let subtotalCents = 0n;
    const processedLines = lines.map(l => {
      const lineTotal = BigInt(l.unitPriceCents) * BigInt(l.quantity || 1);
      subtotalCents += lineTotal;
      return {
        id: generateUUIDv7(),
        invoice_id: invoiceId,
        description: l.description,
        quantity: l.quantity || 1,
        unit_price_cents: BigInt(l.unitPriceCents),
        total_cents: lineTotal
      };
    });

    const totalCents = subtotalCents - BigInt(discountCents) + BigInt(taxCents);

    const invoiceRecord = {
      id: invoiceId,
      tenant_id: tenantId,
      invoice_number: invoiceNumber,
      billing_account_id: billingAccountId,
      subscription_id: subscriptionId,
      plan_version_id: planVersionId,
      subtotal_cents: subtotalCents,
      discount_cents: BigInt(discountCents),
      tax_cents: BigInt(taxCents),
      total_cents: totalCents,
      currency,
      status: INVOICE_STATUSES.ISSUED,
      issued_at: new Date().toISOString(),
      due_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      paid_at: null,
      voided_at: null,
      notes,
      created_at: new Date().toISOString()
    };

    await tx.insert('invoices', invoiceRecord);

    for (const line of processedLines) {
      await tx.insert('invoice_lines', line);
    }

    return {
      invoice: invoiceRecord,
      lines: processedLines
    };
  }

  /**
   * Issues a Credit Note to correct or reverse an invoice without mutating the original (INV-12-05)
   */
  static async createCreditNote(tx, {
    invoiceId,
    amountCents,
    reason = 'BILLING_CORRECTION'
  }) {
    const invoice = await tx.findById('invoices', invoiceId);
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

    if (BigInt(amountCents) > BigInt(invoice.total_cents)) {
      throw new Error(`Credit Note amount (${amountCents}) cannot exceed invoice total (${invoice.total_cents})`);
    }

    const tenantId = tx.session.tenantId;
    const creditNoteId = generateUUIDv7();
    const existingCNs = await tx.query('credit_notes', cn => cn.tenant_id === tenantId);
    const cnNumber = `CN-${new Date().getFullYear()}-${String(existingCNs.length + 1).padStart(6, '0')}`;

    const creditNoteRecord = {
      id: creditNoteId,
      tenant_id: tenantId,
      invoice_id: invoiceId,
      credit_note_number: cnNumber,
      amount_cents: BigInt(amountCents),
      reason,
      status: 'ISSUED',
      created_at: new Date().toISOString()
    };

    await tx.insert('credit_notes', creditNoteRecord);

    return creditNoteRecord;
  }

  /**
   * Voids an invoice formally (retaining historical invoice identity)
   */
  static async voidInvoice(tx, invoiceId, reason) {
    const invoice = await tx.findById('invoices', invoiceId);
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

    return await tx.update('invoices', invoice.id, {
      status: INVOICE_STATUSES.VOIDED,
      voided_at: new Date().toISOString(),
      notes: `${invoice.notes || ''} [VOIDED: ${reason}]`.trim()
    });
  }
}

module.exports = {
  InvoiceService
};
