/**
 * Supplier Payables & Payments Domain Service for BoutiqFlow DZ
 * 
 * Invariants:
 * - INV-05-07: Supplier payment cannot exceed outstanding payable.
 * - INV-05-08: Duplicate financial operationId cannot create duplicate financial mutation.
 * - INV-05-11: Cross-tenant supplier/financial access is impossible.
 * - INV-05-14: Financial amounts use strict integer centimes.
 */

const SUPPLIER_PAYMENT_METHODS = {
  CASH: 'CASH',
  BANK_TRANSFER: 'BANK_TRANSFER',
  CHECK: 'CHECK',
  BARIDIMOB: 'BARIDIMOB',
  OTHER: 'OTHER'
};

/**
 * Get supplier financial balance and payables
 * Outstanding = Total Received Goods - Total Returns - Total Payments
 * @param {TenantTransaction} tx
 * @param {string} supplierId
 */
async function getSupplierBalance(tx, supplierId) {
  const supplier = await tx.findById('suppliers', supplierId);
  if (!supplier) {
    throw new Error(`Supplier not found: ${supplierId}`);
  }

  // 1. Total received goods
  const receipts = await tx.query('purchase_receipts', r => r.supplier_id === supplierId);
  const totalReceivedCentimes = receipts.reduce((acc, r) => acc + BigInt(r.total_cost_centimes || 0n), 0n);

  // 2. Total purchase returns
  const returns = await tx.query('purchase_returns', r => r.supplier_id === supplierId);
  const totalReturnedCentimes = returns.reduce((acc, r) => acc + BigInt(r.total_return_centimes || 0n), 0n);

  // 3. Total supplier payments
  const payments = await tx.query('supplier_payments', p => p.supplier_id === supplierId);
  const totalPaidCentimes = payments.reduce((acc, p) => acc + BigInt(p.amount_centimes || 0n), 0n);

  // Outstanding payable
  const outstandingPayableCentimes = totalReceivedCentimes - totalReturnedCentimes - totalPaidCentimes;

  return {
    supplierId,
    supplierName: supplier.name,
    totalReceivedCentimes,
    totalReturnedCentimes,
    totalPaidCentimes,
    outstandingPayableCentimes
  };
}

/**
 * Record a payment to a supplier
 * @param {TenantTransaction} tx
 * @param {Object} params
 */
async function recordSupplierPayment(tx, {
  supplierId,
  amountCentimes,
  paymentMethod = SUPPLIER_PAYMENT_METHODS.CASH,
  reference = null,
  purchaseOrderId = null,
  paidAt = new Date().toISOString(),
  paidBy = null,
  operationId = null,
  notes = null
}) {
  const amt = BigInt(amountCentimes);
  if (amt <= 0n) {
    throw new Error('Validation Error: Payment amount must be strictly positive');
  }

  // INV-05-08: Idempotency check per tenant
  if (operationId) {
    const existing = await tx.query('supplier_payments', p => p.operation_id === operationId);
    if (existing.length > 0) {
      return { payment: existing[0], replayed: true };
    }
  }

  const supplier = await tx.findById('suppliers', supplierId);
  if (!supplier) {
    throw new Error(`Supplier not found: ${supplierId}`);
  }

  // Invariant INV-05-07: Payment cannot exceed outstanding payable
  const balance = await getSupplierBalance(tx, supplierId);
  if (amt > balance.outstandingPayableCentimes) {
    throw new Error(`Invariant Violation INV-05-07: Payment amount (${amt} centimes) exceeds outstanding payable balance (${balance.outstandingPayableCentimes} centimes) for supplier ${supplierId}`);
  }

  const paymentNumber = `SP-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;

  const payment = await tx.insert('supplier_payments', {
    payment_number: paymentNumber,
    supplier_id: supplierId,
    purchase_order_id: purchaseOrderId,
    amount_centimes: amt,
    payment_method: paymentMethod,
    reference,
    paid_at: paidAt,
    paid_by: paidBy,
    operation_id: operationId,
    notes
  });

  // Record in financial entries ledger (INV-05-12)
  await tx.insert('financial_entries', {
    entry_type: 'SUPPLIER_PAYMENT',
    amount_centimes: amt,
    reference_type: 'SUPPLIER_PAYMENT',
    reference_id: payment.id,
    supplier_id: supplierId,
    actor_id: paidBy,
    entry_date: paidAt.split('T')[0],
    metadata: {
      paymentNumber,
      paymentMethod,
      purchaseOrderId,
      reference
    }
  });

  // Record audit log
  await tx.insert('audit_logs', {
    action: 'SUPPLIER_PAYMENT_RECORDED',
    actor_id: paidBy,
    entity_type: 'supplier_payments',
    entity_id: payment.id,
    details: {
      supplierId,
      amountCentimes: amt.toString(),
      paymentMethod,
      paymentNumber
    }
  });

  return { payment, replayed: false };
}

module.exports = {
  SUPPLIER_PAYMENT_METHODS,
  getSupplierBalance,
  recordSupplierPayment
};
