/**
 * Financial Management, Operating Expenses & Profit Domain for BoutiqFlow DZ
 * 
 * Invariants:
 * - INV-05-05: Historical sale cost never changes.
 * - INV-05-06: Historical COGS never changes because of current catalog cost.
 * - INV-05-08: Duplicate financial operationId cannot create duplicate financial mutation.
 * - INV-05-09: Expense posting is immutable except controlled void/reversal.
 * - INV-05-12: Revenue, COGS and expenses are separated domains/metrics.
 * - INV-05-14: Financial amounts use strict integer centimes.
 * - INV-05-15: Historical financial reports are based on transaction snapshots/events, not current catalog values.
 */

const { generateUUIDv7 } = require('../db/utils');

const EXPENSE_CATEGORIES = {
  RENT: 'RENT',
  ELECTRICITY: 'ELECTRICITY',
  INTERNET: 'INTERNET',
  TRANSPORT: 'TRANSPORT',
  PACKAGING: 'PACKAGING',
  SALARIES: 'SALARIES',
  MARKETING: 'MARKETING',
  MAINTENANCE: 'MAINTENANCE',
  OTHER: 'OTHER'
};

const EXPENSE_STATUSES = {
  POSTED: 'POSTED',
  VOIDED: 'VOIDED'
};

const FINANCIAL_ENTRY_TYPES = {
  SALE_REVENUE: 'SALE_REVENUE',
  SALE_COGS: 'SALE_COGS',
  PURCHASE_RECEIVED: 'PURCHASE_RECEIVED',
  SUPPLIER_PAYMENT: 'SUPPLIER_PAYMENT',
  EXPENSE_POSTED: 'EXPENSE_POSTED',
  EXPENSE_VOIDED: 'EXPENSE_VOIDED',
  CUSTOMER_REFUND: 'CUSTOMER_REFUND',
  PURCHASE_RETURN: 'PURCHASE_RETURN'
};

/**
 * Record an operating expense
 */
async function recordExpense(tx, {
  categoryId,
  amountCentimes,
  paymentMethod = 'CASH',
  description = null,
  isRecurring = false,
  recurrenceInterval = null,
  expenseDate = new Date().toISOString().split('T')[0],
  reference = null,
  createdBy = null,
  operationId = null
}) {
  const amt = BigInt(amountCentimes);
  if (amt <= 0n) {
    throw new Error('Expense amount must be strictly positive');
  }

  // INV-05-08: Idempotency check per tenant
  if (operationId) {
    const existing = await tx.query('expenses', e => e.operation_id === operationId);
    if (existing.length > 0) {
      return existing[0];
    }
  }

  const expense = await tx.insert('expenses', {
    category_id: categoryId,
    amount_centimes: amt,
    payment_method: paymentMethod,
    description,
    is_recurring: isRecurring,
    recurrence_interval: recurrenceInterval,
    expense_date: expenseDate,
    reference,
    created_by: createdBy,
    operation_id: operationId,
    status: EXPENSE_STATUSES.POSTED
  });

  // Record Financial Entry in append-only trail (INV-05-12)
  await tx.insert('financial_entries', {
    entry_type: FINANCIAL_ENTRY_TYPES.EXPENSE_POSTED,
    amount_centimes: amt,
    reference_type: 'EXPENSE',
    reference_id: expense.id,
    actor_id: createdBy,
    entry_date: expenseDate,
    metadata: {
      categoryId,
      paymentMethod,
      description,
      reference
    }
  });

  await tx.insert('audit_logs', {
    action: 'EXPENSE_POSTED',
    actor_id: createdBy,
    entity_type: 'expenses',
    entity_id: expense.id,
    details: {
      categoryId,
      amountCentimes: amt.toString(),
      paymentMethod
    }
  });

  return expense;
}

/**
 * Controlled void of an expense (INV-05-09)
 */
async function voidExpense(tx, {
  expenseId,
  voidedBy = null,
  reason = 'ERROR_CORRECTION'
}) {
  const expense = await tx.findById('expenses', expenseId);
  if (!expense) {
    throw new Error(`Expense not found: ${expenseId}`);
  }

  if (expense.status === EXPENSE_STATUSES.VOIDED) {
    throw new Error('Expense is already VOIDED');
  }

  const updated = await tx.update('expenses', expenseId, {
    status: EXPENSE_STATUSES.VOIDED,
    voided_at: new Date().toISOString(),
    voided_by: voidedBy,
    void_reason: reason
  });

  // Record reversal financial entry
  await tx.insert('financial_entries', {
    entry_type: FINANCIAL_ENTRY_TYPES.EXPENSE_VOIDED,
    amount_centimes: -BigInt(expense.amount_centimes),
    reference_type: 'EXPENSE',
    reference_id: expense.id,
    actor_id: voidedBy,
    entry_date: new Date().toISOString().split('T')[0],
    metadata: {
      originalAmountCentimes: expense.amount_centimes.toString(),
      reason
    }
  });

  await tx.insert('audit_logs', {
    action: 'EXPENSE_VOIDED',
    actor_id: voidedBy,
    entity_type: 'expenses',
    entity_id: expense.id,
    details: {
      amountCentimes: expense.amount_centimes.toString(),
      reason
    }
  });

  return updated;
}

/**
 * Record non-operating income (e.g. scrap sale, financial subsidy)
 */
async function recordIncome(tx, {
  source,
  amountCentimes,
  paymentMethod = 'CASH',
  description = null,
  entryDate = new Date().toISOString().split('T')[0]
}) {
  const amt = BigInt(amountCentimes);
  if (amt <= 0n) throw new Error('Income amount must be strictly positive');

  return await tx.insert('income_entries', {
    source,
    amount_centimes: amt,
    payment_method: paymentMethod,
    description,
    entry_date: entryDate
  });
}

/**
 * Record a financial entry directly in the ledger
 */
async function recordFinancialEntry(tx, {
  entryType,
  amountCentimes,
  referenceType = null,
  referenceId = null,
  supplierId = null,
  customerId = null,
  locationId = null,
  actorId = null,
  entryDate = new Date().toISOString().split('T')[0],
  metadata = {}
}) {
  const amt = BigInt(amountCentimes);
  return await tx.insert('financial_entries', {
    entry_type: entryType,
    amount_centimes: amt,
    reference_type: referenceType,
    reference_id: referenceId,
    supplier_id: supplierId,
    customer_id: customerId,
    location_id: locationId,
    actor_id: actorId,
    entry_date: entryDate,
    metadata
  });
}

/**
 * True Profit & Loss (P&L) Statement Generator (INV-05-12, INV-05-15)
 * 
 * Formal Definitions:
 * - Gross Sales / Revenue = SUM(completed sale totals)
 * - COGS = SUM(sale item quantity * cost_snapshot_centimes)
 * - Gross Profit = Gross Sales - COGS
 * - Operating Expenses = SUM(posted operating expenses)
 * - Operating Profit = Gross Profit - Operating Expenses
 * - Net Profit = Operating Profit + Other Income
 */
async function generatePnLReport(tx, { startDate, endDate } = {}) {
  // 1. Fetch completed sales in period
  const sales = await tx.query('sales', s => {
    if (s.status !== 'COMPLETED' && s.status !== 'PARTIALLY_REFUNDED') return false;
    const saleDate = s.created_at.split('T')[0];
    if (startDate && saleDate < startDate) return false;
    if (endDate && saleDate > endDate) return false;
    return true;
  });

  const saleIds = new Set(sales.map(s => s.id));
  let grossSales = 0n;
  for (const s of sales) {
    grossSales += BigInt(s.total_centimes);
  }

  // 2. Fetch sale items and calculate COGS using historical cost snapshot (INV-05-05, INV-05-06, INV-05-15)
  // NEVER recalculate using current catalog product_variants.cost_price!
  const allItems = await tx.query('sale_items', item => saleIds.has(item.sale_id));
  let cogs = 0n;
  for (const item of allItems) {
    const qty = BigInt(item.qty || item.quantity || 1);
    const unitCost = BigInt(item.cost_snapshot_centimes !== undefined ? item.cost_snapshot_centimes : (item.costAtSale || 0n));
    cogs += qty * unitCost;
  }

  // Adjust for customer refunds if any in period
  const refunds = await tx.query('refunds', r => {
    if (startDate && r.created_at.split('T')[0] < startDate) return false;
    if (endDate && r.created_at.split('T')[0] > endDate) return false;
    return true;
  });
  let totalRefundsCentimes = 0n;
  for (const r of refunds) {
    totalRefundsCentimes += BigInt(r.total_refund_centimes || 0n);
  }

  // Net Revenue after refunds
  const netRevenue = grossSales - totalRefundsCentimes;
  const grossProfit = grossSales - cogs;
  const grossMarginPercent = grossSales > 0n
    ? (Number(grossProfit * 10000n / grossSales) / 100).toFixed(2) + '%'
    : '0.00%';

  // 3. Operating expenses in period: strictly exclude VOIDED expenses (INV-05-09)
  const expenses = await tx.query('expenses', e => {
    if (e.status && e.status !== EXPENSE_STATUSES.POSTED) return false;
    if (startDate && e.expense_date < startDate) return false;
    if (endDate && e.expense_date > endDate) return false;
    return true;
  });

  let totalExpenses = 0n;
  const expensesByCategory = {};
  for (const e of expenses) {
    const amt = BigInt(e.amount_centimes);
    totalExpenses += amt;
    const cat = e.category_id || 'OTHER';
    expensesByCategory[cat] = (expensesByCategory[cat] || 0n) + amt;
  }

  // 4. Other income in period
  const incomeEntries = await tx.query('income_entries', inc => {
    if (startDate && inc.entry_date < startDate) return false;
    if (endDate && inc.entry_date > endDate) return false;
    return true;
  });

  let totalOtherIncome = 0n;
  for (const inc of incomeEntries) {
    totalOtherIncome += BigInt(inc.amount_centimes);
  }

  const operatingProfit = grossProfit - totalExpenses;
  const netProfit = operatingProfit + totalOtherIncome;

  return {
    startDate,
    endDate,
    salesCount: sales.length,
    grossSales,
    cogs,
    grossProfit,
    grossMarginPercent,
    totalExpenses,
    expensesByCategory,
    totalOtherIncome,
    operatingProfit,
    netProfit
  };
}

/**
 * Comprehensive Financial Consistency Balance (Requirement 22)
 * Computes the unified financial state:
 * - Revenue, COGS, Gross Profit, Expenses, Operating Profit
 * - Current Stock Value (Asset)
 * - Supplier Payables (Liability)
 */
async function calculateFinancialState(tx) {
  // PnL metrics
  const pnl = await generatePnLReport(tx);

  // Supplier payables
  const receipts = await tx.query('purchase_receipts');
  const totalReceivedGoods = receipts.reduce((acc, r) => acc + BigInt(r.total_cost_centimes || 0n), 0n);

  const returns = await tx.query('purchase_returns');
  const totalPurchaseReturns = returns.reduce((acc, r) => acc + BigInt(r.total_return_centimes || 0n), 0n);

  const payments = await tx.query('supplier_payments');
  const totalSupplierPayments = payments.reduce((acc, p) => acc + BigInt(p.amount_centimes || 0n), 0n);

  const totalSupplierPayables = totalReceivedGoods - totalPurchaseReturns - totalSupplierPayments;

  // Inventory asset value = sum(on_hand * variant.cost_price)
  const variants = await tx.query('product_variants');
  const variantMap = new Map(variants.map(v => [v.id, v]));

  const stockLevels = await tx.query('stock_levels');
  let totalInventoryValue = 0n;
  for (const lvl of stockLevels) {
    const v = variantMap.get(lvl.variant_id);
    if (v && lvl.on_hand > 0) {
      totalInventoryValue += BigInt(lvl.on_hand) * BigInt(v.cost_price || 0n);
    }
  }

  return {
    revenue: pnl.grossSales,
    cogs: pnl.cogs,
    grossProfit: pnl.grossProfit,
    operatingExpenses: pnl.totalExpenses,
    operatingProfit: pnl.operatingProfit,
    supplierPayables: totalSupplierPayables,
    inventoryValue: totalInventoryValue
  };
}

module.exports = {
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  FINANCIAL_ENTRY_TYPES,
  recordExpense,
  voidExpense,
  recordIncome,
  recordFinancialEntry,
  generatePnLReport,
  calculateFinancialState
};
