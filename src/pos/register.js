const { generateUUIDv7 } = require('../db/utils');
const { applyStockMovement, MOVEMENT_REASONS, withInventoryLocks } = require('../inventory/ledger');
const { ROLES, PERMISSIONS, authorize, hasPermission } = require('../rbac/permissions');

/**
 * Point of Sale (POS) & Cash Register Engine for BoutiqFlow DZ (Phase 04)
 * Implements Mandatory Invariants:
 * - INV-04-01: Completed Sale is immutable
 * - INV-04-02: Sale total equals sum of SaleLines after discounts
 * - INV-04-03: Payment total equals Sale total
 * - INV-04-04: Every completed Sale consumes inventory exactly once
 * - INV-04-05: Every cash payment creates exactly one cash movement
 * - INV-04-06: Refund quantity cannot exceed sold quantity
 * - INV-04-07: Completed Sale cannot be silently deleted
 * - INV-04-08: Duplicate operationId cannot create duplicate Sale
 * - INV-04-09: Cash session cannot be double-opened
 * - INV-04-10: Closed cash session cannot receive normal sales
 * - INV-04-11: Historical Sale snapshots remain unchanged
 * - INV-04-12: Cross-tenant POS operations are impossible
 * - INV-04-13: Receipt identity maps to exactly one Sale
 * - INV-04-14: Failed Sale transaction leaves zero partial mutations
 */

const TENDER_TYPES = {
  CASH: 'CASH',
  CARD: 'CARD',
  BARIDIMOB: 'BARIDIMOB',
  CUSTOMER_CREDIT: 'CUSTOMER_CREDIT'
};

const SALE_STATUSES = {
  DRAFT: 'DRAFT',
  COMPLETED: 'COMPLETED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
  VOIDED: 'VOIDED'
};

const CASH_TRANSACTION_TYPES = {
  FLOAT_IN: 'FLOAT_IN',
  SALE_CASH: 'SALE_CASH',
  REFUND_CASH: 'REFUND_CASH',
  CASH_IN: 'CASH_IN',
  CASH_OUT: 'CASH_OUT'
};

/**
 * Helper to record audit events within POS transactions
 */
async function recordPosAuditEvent(tx, { eventType, actorId, referenceId, details = {} }) {
  const tenantId = tx.session.tenantId;
  return await tx.insert('audit_logs', {
    tenant_id: tenantId,
    actor_id: actorId || tx.session.userId || 'system',
    event_type: eventType,
    reference_id: referenceId,
    details_json: details,
    created_at: new Date().toISOString()
  });
}

/**
 * 1. Creates a Physical Cash Register
 */
async function createCashRegister(tx, { name, locationId, code = 'REG-01' }) {
  const loc = await tx.findById('inventory_locations', locationId);
  if (!loc) throw new Error(`Location ${locationId} not found or foreign tenant`);

  return await tx.insert('cash_registers', {
    name,
    location_id: locationId,
    code,
    is_active: true
  });
}

/**
 * 2. Opens a Cash Register Session (INV-04-09)
 */
async function openRegisterSession(tx, {
  registerId = null,
  locationId,
  cashierId,
  openingCashCentimes = 0n,
  notes = ''
}) {
  const tenantId = tx.session.tenantId;

  // Validate location
  const loc = await tx.findById('inventory_locations', locationId);
  if (!loc) throw new Error(`Location ${locationId} not found or foreign tenant (INV-04-12)`);

  // Validate cashier
  if (cashierId) {
    const user = await tx.findById('users', cashierId);
    if (!user) throw new Error(`Cashier user ${cashierId} not found or foreign tenant (INV-04-12)`);
  }

  // Check if register exists in tenant and whether it already has an active OPEN session (INV-04-09, INV-04-12)
  if (registerId) {
    const reg = await tx.findById('cash_registers', registerId);
    if (!reg) {
      throw new Error(`Tenant Isolation Error: Cash register ${registerId} not found or foreign tenant (INV-04-12)`);
    }
    const existingOpen = await tx.query('register_sessions', s =>
      s.register_id === registerId && s.status === 'OPEN'
    );
    if (existingOpen.length > 0) {
      throw new Error(`Validation Error: Cash register ${registerId} already has an active OPEN session (INV-04-09)`);
    }
  }

  const openingFloat = BigInt(openingCashCentimes);
  if (openingFloat < 0n) {
    throw new Error('Validation Error: Opening cash float cannot be negative');
  }

  const session = await tx.insert('register_sessions', {
    register_id: registerId,
    location_id: locationId,
    cashier_id: cashierId,
    status: 'OPEN',
    opening_cash_centimes: openingFloat,
    expected_cash_centimes: openingFloat,
    counted_cash_centimes: 0n,
    difference_centimes: 0n,
    notes
  });

  // Mirror to cash_sessions
  await tx.insert('cash_sessions', {
    id: session.id,
    register_id: registerId,
    location_id: locationId,
    cashier_id: cashierId,
    status: 'OPEN',
    opening_cash_centimes: openingFloat,
    expected_cash_centimes: openingFloat
  });

  // Record initial float in cash transactions (INV-04-05)
  if (openingFloat > 0n) {
    await tx.insert('cash_transactions', {
      session_id: session.id,
      cashier_id: cashierId,
      type: CASH_TRANSACTION_TYPES.FLOAT_IN,
      amount_centimes: openingFloat,
      notes: 'Initial opening float'
    });
  }

  await recordPosAuditEvent(tx, {
    eventType: 'CASH_SESSION_OPENED',
    actorId: cashierId,
    referenceId: session.id,
    details: { openingCashCentimes: openingFloat.toString() }
  });

  return session;
}

/**
 * 3. Generates X-Report (Mid-day read of register state)
 */
async function generateXReport(tx, sessionId) {
  const session = await tx.findById('register_sessions', sessionId);
  if (!session || session.status !== 'OPEN') {
    throw new Error('Register session not found or already closed');
  }

  const sales = await tx.query('sales', s => s.register_session_id === sessionId && s.status !== SALE_STATUSES.VOIDED);
  const saleIds = new Set(sales.map(s => s.id));

  const payments = await tx.query('sale_payments', p => saleIds.has(p.sale_id));
  const refunds = await tx.query('refunds', r => r.session_id === sessionId);

  let cashSalesTotal = 0n;
  let cardTotal = 0n;
  let baridimobTotal = 0n;
  let creditTotal = 0n;

  for (const p of payments) {
    const amt = BigInt(p.amount_centimes);
    if (p.tender_type === TENDER_TYPES.CASH) cashSalesTotal += amt;
    else if (p.tender_type === TENDER_TYPES.CARD) cardTotal += amt;
    else if (p.tender_type === TENDER_TYPES.BARIDIMOB) baridimobTotal += amt;
    else if (p.tender_type === TENDER_TYPES.CUSTOMER_CREDIT) creditTotal += amt;
  }

  let refundsCashTotal = 0n;
  for (const r of refunds) {
    refundsCashTotal += BigInt(r.amount_centimes || 0n);
  }

  // Cash transactions (cash adjustments, float, cash sales, cash refunds)
  const cashTxList = await tx.query('cash_transactions', ct => ct.session_id === sessionId);
  let netCashMovements = 0n;
  for (const ct of cashTxList) {
    netCashMovements += BigInt(ct.amount_centimes);
  }

  const openingCash = BigInt(session.opening_cash_centimes);
  const expectedCash = netCashMovements > 0n && cashTxList.length > 0
    ? netCashMovements
    : openingCash + cashSalesTotal - refundsCashTotal;

  return {
    sessionId,
    status: 'OPEN',
    salesCount: sales.length,
    refundsCount: refunds.length,
    openingCash,
    cashTotal: cashSalesTotal,
    cardTotal,
    baridimobTotal,
    creditTotal,
    refundsCashTotal,
    expectedCash
  };
}

/**
 * 4. Closes Cash Register Session (Z-Report, INV-04-10)
 */
async function closeRegisterSession(tx, {
  sessionId,
  cashierId,
  countedCashCentimes,
  notes = ''
}) {
  const session = await tx.findById('register_sessions', sessionId);
  if (!session) {
    throw new Error(`Register session ${sessionId} not found (INV-04-12)`);
  }
  if (session.status === 'CLOSED') {
    throw new Error('Session Error: Cannot close an already closed register session (INV-04-10)');
  }

  const xReport = await generateXReport(tx, sessionId);
  const counted = BigInt(countedCashCentimes);
  const difference = counted - xReport.expectedCash;

  const zReport = {
    ...xReport,
    status: 'CLOSED',
    countedCash: counted,
    difference,
    closedAt: new Date().toISOString(),
    closedBy: cashierId || session.cashier_id,
    notes
  };

  await tx.update('register_sessions', sessionId, {
    status: 'CLOSED',
    expected_cash_centimes: xReport.expectedCash,
    counted_cash_centimes: counted,
    difference_centimes: difference,
    closed_at: zReport.closedAt,
    z_report_json: zReport
  });

  await tx.update('cash_sessions', sessionId, {
    status: 'CLOSED',
    expected_cash_centimes: xReport.expectedCash,
    counted_cash_centimes: counted,
    difference_centimes: difference,
    closed_at: zReport.closedAt
  });

  await recordPosAuditEvent(tx, {
    eventType: 'CASH_SESSION_CLOSED',
    actorId: cashierId || session.cashier_id,
    referenceId: sessionId,
    details: {
      expectedCashCentimes: xReport.expectedCash.toString(),
      countedCashCentimes: counted.toString(),
      differenceCentimes: difference.toString()
    }
  });

  return zReport;
}

/**
 * 5. Manual Cash Adjustments (Petty cash / drawer deposit / withdrawal)
 */
async function adjustCash(tx, {
  sessionId,
  cashierId,
  amountCentimes,
  type = CASH_TRANSACTION_TYPES.CASH_IN,
  reason,
  actorRole = ROLES.MANAGER
}) {
  if (actorRole === ROLES.CASHIER) {
    authorize(ROLES.CASHIER, PERMISSIONS.CASH_ADJUST);
  }

  const session = await tx.findById('register_sessions', sessionId);
  if (!session || session.status !== 'OPEN') {
    throw new Error('Session Error: Cannot adjust cash on a closed or non-existent session (INV-04-10)');
  }

  const amount = BigInt(amountCentimes);
  if (amount === 0n) throw new Error('Validation Error: Cash adjustment cannot be zero');

  const signedAmount = type === CASH_TRANSACTION_TYPES.CASH_OUT ? -amount : amount;

  const txRecord = await tx.insert('cash_transactions', {
    session_id: sessionId,
    cashier_id: cashierId,
    type,
    amount_centimes: signedAmount,
    notes: reason || 'Manual cash adjustment'
  });

  await recordPosAuditEvent(tx, {
    eventType: 'CASH_ADJUSTED',
    actorId: cashierId,
    referenceId: txRecord.id,
    details: { type, amountCentimes: signedAmount.toString(), reason }
  });

  return txRecord;
}

/**
 * 6. Completes a POS Sale atomically with split tender, credit, cost snapshotting, and stock consumption
 * Implements: INV-04-01, INV-04-02, INV-04-03, INV-04-04, INV-04-05, INV-04-08, INV-04-10, INV-04-11, INV-04-14
 */
async function processSale(tx, {
  sessionId,
  registerId = null,
  locationId,
  cashierId,
  customerId = null,
  items,
  payments,
  discountCentimes = 0n,
  idempotencyKey,
  operationId = idempotencyKey,
  deviceId = 'POS-1',
  sequenceNumber = 1,
  notes = '',
  actorRole = ROLES.CASHIER,
  isExchange = false
}) {
  const resolvedOpId = operationId || idempotencyKey;
  const executeSale = async () => {
  if (!items || items.length === 0) {
    throw new Error('Sale must contain at least one item');
  }
  if (!payments || payments.length === 0) {
    throw new Error('Sale must contain at least one payment tender');
  }

  // 1. Idempotency Check (INV-04-08)
  const resolvedOpId = operationId || idempotencyKey;
  if (resolvedOpId) {
    const existingKey = await tx.query('sales', s =>
      s.idempotency_key === resolvedOpId || s.operation_id === resolvedOpId
    );
    if (existingKey.length > 0) {
      const existing = existingKey[0];
      return {
        saleId: existing.id,
        receiptNumber: existing.receipt_number,
        subtotal: existing.subtotal_centimes,
        total: existing.total_centimes,
        paymentsSum: existing.total_centimes,
        changeDue: 0n,
        creditAmount: 0n,
        replayed: true,
        status: existing.status
      };
    }
  }

  // 2. Validate Session is OPEN if session provided (INV-04-10)
  if (sessionId) {
    const session = await tx.findById('register_sessions', sessionId);
    if (!session) {
      throw new Error(`Register session ${sessionId} not found or foreign tenant (INV-04-12)`);
    }
    if (session.status !== 'OPEN') {
      throw new Error(`Session Error: Cash session ${sessionId} is closed. Normal sales are prohibited (INV-04-10)`);
    }
  }

  // 3. Validate Location
  const loc = await tx.findById('inventory_locations', locationId);
  if (!loc) {
    throw new Error(`Location ${locationId} not found or foreign tenant (INV-04-12)`);
  }

  const receiptNumber = `${deviceId}-${sequenceNumber.toString().padStart(6, '0')}`;
  const saleId = generateUUIDv7();

  let subtotal = 0n;
  const processedItems = [];

  // 4. Validate Items and Build Permanent Historical Snapshots (INV-04-02, INV-04-11)
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const variant = await tx.findById('product_variants', item.variantId);
    if (!variant) {
      throw new Error(`Tenant Isolation / Catalog Error: Variant ${item.variantId} not found in tenant (INV-04-12)`);
    }

    const product = await tx.findById('products', variant.product_id);
    if (!product || product.is_active === false) {
      // In size exchange, return item can be inactive; newly bought item must be active
      if (item.qty > 0) {
        throw new Error(`Catalog Error: Product '${product ? product.name : variant.product_id}' is archived`);
      }
    }

    const qty = item.qty;
    if (!Number.isInteger(qty) || qty === 0 || (!isExchange && qty < 0)) {
      throw new Error('Validation Error: Item quantity must be a strictly positive integer');
    }

    const standardPrice = BigInt(variant.sale_price || 0n);
    let unitPrice = standardPrice;

    if (item.unitPriceCentimes !== undefined) {
      const customPrice = BigInt(item.unitPriceCentimes);
      if (customPrice < 0n) throw new Error('Validation Error: Item unit price cannot be negative');

      // Cashier price override check (RBAC)
      if (customPrice !== standardPrice && actorRole === ROLES.CASHIER) {
        authorize(ROLES.CASHIER, PERMISSIONS.PRICE_OVERRIDE);
      }
      unitPrice = customPrice;
    }

    const itemDiscount = BigInt(item.discountCentimes || 0n);
    if (itemDiscount < 0n) throw new Error('Validation Error: Line discount cannot be negative');

    const rawLineTotal = (BigInt(qty) * unitPrice) - itemDiscount;
    subtotal += rawLineTotal;

    const costSnapshot = BigInt(variant.cost_price || 0n);
    const variantName = [variant.size, variant.color].filter(Boolean).join(' / ') || 'Standard';

    processedItems.push({
      variantId: item.variantId,
      productId: variant.product_id,
      productName: product ? product.name : 'Unknown Product',
      variantName,
      sku: variant.sku,
      barcode: variant.barcode,
      qty,
      costSnapshot,
      unitPrice,
      itemDiscount,
      lineTotal: rawLineTotal
    });
  }

  const cartDiscount = BigInt(discountCentimes || 0n);
  if (cartDiscount < 0n) {
    throw new Error('Validation Error: Cart discount cannot be negative');
  }
  if (cartDiscount > subtotal && subtotal > 0n) {
    throw new Error(`Validation Error: Cart discount (${cartDiscount}) cannot exceed subtotal (${subtotal})`);
  }

  // Total equals sum of SaleLines after discounts (INV-04-02)
  const total = subtotal > cartDiscount ? subtotal - cartDiscount : 0n;

  // 5. Validate Payments (INV-04-03)
  let paymentsSum = 0n;
  let creditAmount = 0n;
  let cashTenderAmount = 0n;

  for (const p of payments) {
    const amt = BigInt(p.amountCentimes);
    if (amt < 0n || (amt === 0n && total > 0n)) {
      throw new Error('Validation Error: Payment amount must be strictly positive');
    }
    paymentsSum += amt;

    if (p.tenderType === TENDER_TYPES.CUSTOMER_CREDIT) {
      creditAmount += amt;
    } else if (p.tenderType === TENDER_TYPES.CASH) {
      cashTenderAmount += amt;
    }
  }

  if (paymentsSum < total) {
    throw new Error(`Insufficient payment: total is ${total} but payments sum to ${paymentsSum} (INV-04-03)`);
  }

  const changeDue = paymentsSum > total ? paymentsSum - total : 0n;

  // 6. Consume Inventory atomically via authoritative Inventory Engine (INV-04-04)
  for (let idx = 0; idx < processedItems.length; idx++) {
    const pItem = processedItems[idx];
    await applyStockMovement(tx, {
      variantId: pItem.variantId,
      locationId,
      qty: -pItem.qty,
      costPriceCentimes: pItem.costSnapshot,
      reason: pItem.qty > 0 ? MOVEMENT_REASONS.POS_SALE : MOVEMENT_REASONS.RETURN_RESTOCK,
      referenceType: 'SALE_RECEIPT',
      referenceId: saleId,
      operationId: resolvedOpId ? `${resolvedOpId}-ITEM-${idx}` : null,
      actorId: cashierId
    });
  }

  // 7. Handle Customer Credit ("كريدي")
  if (creditAmount > 0n) {
    if (!customerId) {
      throw new Error('Validation Error: Customer ID is strictly required for credit sales');
    }
    const customer = await tx.findById('customers', customerId);
    if (!customer) throw new Error(`Customer ${customerId} not found or foreign tenant (INV-04-12)`);

    await tx.insert('customer_ledger', {
      customer_id: customerId,
      type: 'SALE_CREDIT',
      amount_centimes: creditAmount,
      reference_id: saleId,
      notes: `Credit on receipt ${receiptNumber}`
    });

    const newDebt = BigInt(customer.debt_balance_centimes || 0n) + creditAmount;
    await tx.update('customers', customer.id, {
      debt_balance_centimes: newDebt
    });
  }

  // 8. Record Cash Drawer Transaction (INV-04-05)
  if (cashTenderAmount > 0n && sessionId) {
    const netCashInDrawer = cashTenderAmount - changeDue;
    await tx.insert('cash_transactions', {
      session_id: sessionId,
      cashier_id: cashierId,
      type: CASH_TRANSACTION_TYPES.SALE_CASH,
      amount_centimes: netCashInDrawer,
      reference_id: saleId,
      notes: `Sale cash receipt ${receiptNumber}`
    });
  }

  // 9. Insert Master Sale Record (INV-04-01, INV-04-07)
  const saleRecord = await tx.insert('sales', {
    id: saleId,
    register_session_id: sessionId || null,
    register_id: registerId,
    location_id: locationId,
    cashier_id: cashierId,
    customer_id: customerId,
    receipt_number: receiptNumber,
    device_id: deviceId,
    subtotal_centimes: subtotal,
    discount_centimes: cartDiscount,
    total_centimes: total,
    status: SALE_STATUSES.COMPLETED,
    idempotency_key: resolvedOpId,
    operation_id: resolvedOpId,
    notes
  });

  // 10. Insert SaleLines with Immutable Snapshots (INV-04-11)
  const insertedLines = [];
  for (const pItem of processedItems) {
    const line = await tx.insert('sale_items', {
      sale_id: saleId,
      variant_id: pItem.variantId,
      product_id: pItem.productId,
      product_name: pItem.productName,
      variant_name: pItem.variantName,
      sku: pItem.sku,
      barcode: pItem.barcode,
      qty: pItem.qty,
      cost_snapshot_centimes: pItem.costSnapshot,
      unit_price_centimes: pItem.unitPrice,
      discount_centimes: pItem.itemDiscount,
      total_centimes: pItem.lineTotal
    });
    insertedLines.push(line);
  }

  // 11. Insert Payments
  const insertedPayments = [];
  for (const p of payments) {
    const payment = await tx.insert('sale_payments', {
      sale_id: saleId,
      tender_type: p.tenderType,
      amount_centimes: BigInt(p.amountCentimes),
      reference: p.reference || null,
      status: 'CAPTURED'
    });
    insertedPayments.push(payment);
  }

  // 12. Record Audit Event
  await recordPosAuditEvent(tx, {
    eventType: 'SALE_COMPLETED',
    actorId: cashierId,
    referenceId: saleId,
    details: {
      receiptNumber,
      totalCentimes: total.toString(),
      itemsCount: processedItems.length,
      operationId: resolvedOpId
    }
  });

  return {
    saleId,
    receiptNumber,
    subtotal,
    total,
    paymentsSum,
    changeDue,
    creditAmount,
    items: insertedLines,
    payments: insertedPayments,
    status: SALE_STATUSES.COMPLETED
  };
  };

  if (resolvedOpId) {
    const tenantId = tx.session.tenantId;
    return await withInventoryLocks(['pos:op:' + tenantId + ':' + resolvedOpId], executeSale);
  }
  return await executeSale();
}

/**
 * 7. In-Store Size Exchange in One Flow (UAT-8)
 */
async function processExchange(tx, {
  sessionId,
  locationId,
  cashierId,
  returnedVariantId,
  returnedQty = 1,
  newVariantId,
  newQty = 1,
  idempotencyKey,
  deviceId = 'POS-1',
  sequenceNumber = 1
}) {
  const returnVariant = await tx.findById('product_variants', returnedVariantId);
  const newVariant = await tx.findById('product_variants', newVariantId);
  if (!returnVariant || !newVariant) throw new Error('Variant not found for exchange');

  const items = [
    {
      variantId: returnedVariantId,
      qty: -returnedQty,
      unitPriceCentimes: returnVariant.sale_price,
      discountCentimes: 0n
    },
    {
      variantId: newVariantId,
      qty: newQty,
      unitPriceCentimes: newVariant.sale_price,
      discountCentimes: 0n
    }
  ];

  const netTotal = (BigInt(newQty) * BigInt(newVariant.sale_price)) - (BigInt(returnedQty) * BigInt(returnVariant.sale_price));
  const payments = [];

  if (netTotal === 0n) {
    payments.push({ tenderType: TENDER_TYPES.CASH, amountCentimes: 0n });
  } else if (netTotal > 0n) {
    payments.push({ tenderType: TENDER_TYPES.CASH, amountCentimes: netTotal });
  }

  return await processSale(tx, {
    sessionId,
    locationId,
    cashierId,
    items,
    payments: payments.length > 0 ? payments : [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 0n }],
    idempotencyKey,
    deviceId,
    sequenceNumber,
    isExchange: true
  });
}

/**
 * 8. Process Refund (Full or Partial) with Invariant INV-04-06
 */
async function processRefund(tx, {
  saleId,
  sessionId = null,
  cashierId,
  itemsToRefund, // Array of { saleItemId, qty, reason }
  reason = 'Customer return',
  operationId = null,
  refundTenderType = TENDER_TYPES.CASH,
  actorRole = ROLES.MANAGER
}) {
  // RBAC: Cashier cannot execute refund without authorization
  if (actorRole === ROLES.CASHIER) {
    authorize(ROLES.CASHIER, PERMISSIONS.SALES_REFUND);
  }

  // Idempotency check (INV-04-08)
  if (operationId) {
    const existingKey = await tx.query('refunds', r => r.operation_id === operationId);
    if (existingKey.length > 0) {
      const existing = existingKey[0];
      return {
        refundId: existing.id,
        saleId: existing.sale_id,
        totalRefundCentimes: existing.amount_centimes,
        status: existing.status,
        replayed: true
      };
    }
  }

  const sale = await tx.findById('sales', saleId);
  if (!sale) {
    throw new Error(`Sale ${saleId} not found or foreign tenant (INV-04-12)`);
  }
  if (!['COMPLETED', 'PARTIALLY_REFUNDED'].includes(sale.status)) {
    throw new Error(`Sale Error: Cannot refund sale in status '${sale.status}'`);
  }

  if (!itemsToRefund || itemsToRefund.length === 0) {
    throw new Error('Validation Error: At least one item line must be specified for refund');
  }

  // Fetch past refunds for this sale to enforce INV-04-06
  const pastRefunds = await tx.query('refunds', r => r.sale_id === saleId && r.status === 'COMPLETED');
  const pastRefundIds = new Set(pastRefunds.map(r => r.id));
  const pastLines = await tx.query('refund_lines', rl => pastRefundIds.has(rl.refund_id));

  const refundedQtyByItem = new Map();
  for (const pl of pastLines) {
    refundedQtyByItem.set(pl.sale_item_id, (refundedQtyByItem.get(pl.sale_item_id) || 0) + pl.qty);
  }

  const refundId = generateUUIDv7();
  let totalRefundCentimes = 0n;
  const processedRefundLines = [];

  for (const reqItem of itemsToRefund) {
    const saleItem = await tx.findById('sale_items', reqItem.saleItemId);
    if (!saleItem || saleItem.sale_id !== saleId) {
      throw new Error(`Validation Error: Sale item ${reqItem.saleItemId} not found on sale ${saleId}`);
    }

    const reqQty = reqItem.qty;
    if (!Number.isInteger(reqQty) || reqQty <= 0) {
      throw new Error('Validation Error: Refund quantity must be a strictly positive integer');
    }

    const previouslyRefunded = refundedQtyByItem.get(saleItem.id) || 0;
    const remainingAvailable = saleItem.qty - previouslyRefunded;

    // Invariant INV-04-06: Refund quantity cannot exceed sold quantity
    if (reqQty > remainingAvailable) {
      throw new Error(`Refund Error: Requested refund qty (${reqQty}) exceeds available remaining qty (${remainingAvailable}) on item ${saleItem.id} (INV-04-06)`);
    }

    // Exact unit refund amount
    const unitPrice = BigInt(saleItem.unit_price_centimes);
    const lineDiscount = BigInt(saleItem.discount_centimes || 0n);
    const effectiveLineTotal = (BigInt(saleItem.qty) * unitPrice) - lineDiscount;
    const unitRefundCentimes = effectiveLineTotal / BigInt(saleItem.qty);
    const lineRefundTotal = unitRefundCentimes * BigInt(reqQty);

    totalRefundCentimes += lineRefundTotal;
    refundedQtyByItem.set(saleItem.id, previouslyRefunded + reqQty);

    processedRefundLines.push({
      saleItemId: saleItem.id,
      variantId: saleItem.variant_id,
      qty: reqQty,
      lineRefundTotal,
      reason: reqItem.reason || reason
    });

    // Restock Inventory via Authoritative Engine (INV-04-04)
    await applyStockMovement(tx, {
      variantId: saleItem.variant_id,
      locationId: sale.location_id,
      qty: reqQty, // Positive for return restock
      costPriceCentimes: saleItem.cost_snapshot_centimes || 0n,
      reason: MOVEMENT_REASONS.RETURN_RESTOCK,
      referenceType: 'REFUND',
      referenceId: refundId,
      operationId: operationId ? `${operationId}-RESTOCK-${saleItem.id}` : null,
      actorId: cashierId
    });
  }

  // Reversal in cash transactions if cash refund (INV-04-05)
  if (refundTenderType === TENDER_TYPES.CASH && sessionId) {
    await tx.insert('cash_transactions', {
      session_id: sessionId,
      cashier_id: cashierId,
      type: CASH_TRANSACTION_TYPES.REFUND_CASH,
      amount_centimes: -totalRefundCentimes,
      reference_id: refundId,
      notes: `Cash refund on receipt ${sale.receipt_number}`
    });
  }

  // Insert master refund
  const refundRecord = await tx.insert('refunds', {
    id: refundId,
    sale_id: saleId,
    session_id: sessionId,
    cashier_id: cashierId,
    amount_centimes: totalRefundCentimes,
    tender_type: refundTenderType,
    reason,
    operation_id: operationId,
    status: 'COMPLETED'
  });

  // Insert refund lines
  for (const prl of processedRefundLines) {
    await tx.insert('refund_lines', {
      refund_id: refundId,
      sale_item_id: prl.saleItemId,
      variant_id: prl.variantId,
      qty: prl.qty,
      amount_centimes: prl.lineRefundTotal,
      reason: prl.reason
    });
  }

  // Update sale status (INV-04-01 transition)
  const allSaleItems = await tx.query('sale_items', i => i.sale_id === saleId);
  let totalSold = 0;
  let totalRefunded = 0;
  for (const item of allSaleItems) {
    totalSold += item.qty;
    totalRefunded += (refundedQtyByItem.get(item.id) || 0);
  }

  const newSaleStatus = totalRefunded >= totalSold ? SALE_STATUSES.REFUNDED : SALE_STATUSES.PARTIALLY_REFUNDED;
  await tx.update('sales', saleId, { status: newSaleStatus });

  await recordPosAuditEvent(tx, {
    eventType: 'REFUND_CREATED',
    actorId: cashierId,
    referenceId: refundId,
    details: {
      saleId,
      amountCentimes: totalRefundCentimes.toString(),
      newSaleStatus
    }
  });

  return {
    refundId,
    saleId,
    totalRefundCentimes,
    status: 'COMPLETED',
    saleStatus: newSaleStatus,
    itemsRefunded: processedRefundLines.length
  };
}

/**
 * 9. Voids a Completed Sale (Manager / Owner authorization required)
 */
async function voidSale(tx, {
  saleId,
  cashierId,
  reason,
  actorRole = ROLES.MANAGER
}) {
  if (actorRole === ROLES.CASHIER) {
    authorize(ROLES.CASHIER, PERMISSIONS.SALES_VOID);
  }

  const sale = await tx.findById('sales', saleId);
  if (!sale) {
    throw new Error(`Sale ${saleId} not found or foreign tenant (INV-04-12)`);
  }
  if (sale.status === SALE_STATUSES.VOIDED) {
    throw new Error('Sale Error: Sale is already voided');
  }
  if (sale.status === SALE_STATUSES.REFUNDED || sale.status === SALE_STATUSES.PARTIALLY_REFUNDED) {
    throw new Error('Sale Error: Cannot void a sale that has existing refunds');
  }

  const saleItems = await tx.query('sale_items', i => i.sale_id === saleId);

  // 1. Restock all inventory
  for (const item of saleItems) {
    if (item.qty > 0) {
      await applyStockMovement(tx, {
        variantId: item.variant_id,
        locationId: sale.location_id,
        qty: item.qty,
        costPriceCentimes: item.cost_snapshot_centimes || 0n,
        reason: MOVEMENT_REASONS.RETURN_RESTOCK,
        referenceType: 'SALE_VOID',
        referenceId: saleId,
        actorId: cashierId
      });
    }
  }

  // 2. Revert cash in drawer if cash transaction was recorded
  const cashTxList = await tx.query('cash_transactions', ct => ct.reference_id === saleId);
  for (const ct of cashTxList) {
    if (ct.amount_centimes > 0n) {
      await tx.insert('cash_transactions', {
        session_id: ct.session_id,
        cashier_id: cashierId,
        type: CASH_TRANSACTION_TYPES.REFUND_CASH,
        amount_centimes: -BigInt(ct.amount_centimes),
        reference_id: saleId,
        notes: `Void reversal for receipt ${sale.receipt_number}`
      });
    }
  }

  // 3. Revert customer debt if credit was used
  const creditPayments = await tx.query('sale_payments', p => p.sale_id === saleId && p.tender_type === TENDER_TYPES.CUSTOMER_CREDIT);
  if (creditPayments.length > 0 && sale.customer_id) {
    const customer = await tx.findById('customers', sale.customer_id);
    if (customer) {
      let creditReversal = 0n;
      for (const cp of creditPayments) {
        creditReversal += BigInt(cp.amount_centimes);
      }
      const newDebt = BigInt(customer.debt_balance_centimes) - creditReversal;
      await tx.update('customers', customer.id, { debt_balance_centimes: newDebt > 0n ? newDebt : 0n });
      await tx.insert('customer_ledger', {
        customer_id: customer.id,
        type: 'SALE_CREDIT_REVERSAL',
        amount_centimes: -creditReversal,
        reference_id: saleId,
        notes: `Reversal on voided receipt ${sale.receipt_number}`
      });
    }
  }

  // 4. Update status to VOIDED
  await tx.update('sales', saleId, {
    status: SALE_STATUSES.VOIDED,
    void_reason: reason,
    voided_at: new Date().toISOString(),
    voided_by: cashierId
  });

  await recordPosAuditEvent(tx, {
    eventType: 'SALE_VOIDED',
    actorId: cashierId,
    referenceId: saleId,
    details: { reason }
  });

  return {
    saleId,
    status: SALE_STATUSES.VOIDED,
    voided: true
  };
}

module.exports = {
  TENDER_TYPES,
  SALE_STATUSES,
  CASH_TRANSACTION_TYPES,
  createCashRegister,
  openRegisterSession,
  generateXReport,
  closeRegisterSession,
  adjustCash,
  processSale,
  processExchange,
  processRefund,
  voidSale,
  recordPosAuditEvent
};
