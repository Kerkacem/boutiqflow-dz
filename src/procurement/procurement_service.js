/**
 * Procurement, Supplier & Purchase Order Domain Service for BoutiqFlow DZ
 * 
 * Invariants:
 * - INV-05-01: Purchase Order creation does not mutate stock.
 * - INV-05-02: Only goods receipt mutates stock through InventoryService.
 * - INV-05-03: Received quantity cannot exceed allowed purchase quantity.
 * - INV-05-04: Every received quantity has an auditable cost snapshot.
 * - INV-05-08: Duplicate financial operationId cannot create duplicate financial mutation.
 * - INV-05-10: Purchase return cannot exceed received quantity.
 * - INV-05-11: Cross-tenant supplier/financial access is impossible.
 * - INV-05-13: Failed purchase receipt leaves no partial stock/cost/payable state.
 */

const { receiveStock, issueStock, MOVEMENT_REASONS, MOVEMENT_TYPES } = require('../inventory/ledger');
const { defaultCostingService } = require('./costing_service');
const { generateUUIDv7 } = require('../db/utils');

const PO_STATUSES = {
  DRAFT: 'DRAFT',
  ORDERED: 'ORDERED',
  PARTIALLY_RECEIVED: 'PARTIALLY_RECEIVED',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED'
};

// --- Supplier Management ---

async function createSupplier(tx, {
  name,
  phone = null,
  email = null,
  address = null,
  notes = null,
  active = true
}) {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Validation Error: Supplier name is required');
  }

  const supplier = await tx.insert('suppliers', {
    name: name.trim(),
    phone: phone ? phone.trim() : null,
    email: email ? email.trim().toLowerCase() : null,
    address: address ? address.trim() : null,
    notes: notes ? notes.trim() : null,
    active: Boolean(active)
  });

  await tx.insert('audit_logs', {
    action: 'SUPPLIER_CREATED',
    entity_type: 'suppliers',
    entity_id: supplier.id,
    details: { name: supplier.name }
  });

  return supplier;
}

async function updateSupplier(tx, supplierId, updates) {
  const existing = await tx.findById('suppliers', supplierId);
  if (!existing) {
    throw new Error(`Supplier not found: ${supplierId}`);
  }

  const allowedFields = ['name', 'phone', 'email', 'address', 'notes', 'active'];
  const sanitized = {};
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      sanitized[field] = updates[field];
    }
  }

  const updated = await tx.update('suppliers', supplierId, sanitized);

  await tx.insert('audit_logs', {
    action: 'SUPPLIER_UPDATED',
    entity_type: 'suppliers',
    entity_id: supplierId,
    details: sanitized
  });

  return updated;
}

async function getSupplier(tx, supplierId) {
  return await tx.findById('suppliers', supplierId);
}

async function listSuppliers(tx, filterFn = () => true) {
  return await tx.query('suppliers', filterFn);
}

// --- Purchase Order Lifecycle ---

async function createPurchaseOrder(tx, {
  supplierId,
  locationId,
  lines,
  expectedDate = null,
  notes = null,
  createdBy = null,
  status = PO_STATUSES.ORDERED
}) {
  if (!supplierId) throw new Error('Validation Error: supplierId is required');
  if (!locationId) throw new Error('Validation Error: locationId is required');
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('Validation Error: Purchase order must contain at least one line');
  }

  // Validate tenant ownership
  const supplier = await tx.findById('suppliers', supplierId);
  if (!supplier) throw new Error(`Supplier not found: ${supplierId}`);

  const location = await tx.findById('inventory_locations', locationId);
  if (!location) throw new Error(`Location not found: ${locationId}`);

  if (![PO_STATUSES.DRAFT, PO_STATUSES.ORDERED].includes(status)) {
    throw new Error(`Invalid initial purchase order status: ${status}`);
  }

  const poNumber = `PO-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;

  let totalAmountCentimes = 0n;
  const validatedLines = [];

  for (const line of lines) {
    if (!line.variantId) throw new Error('Validation Error: Line variantId is required');
    const variant = await tx.findById('product_variants', line.variantId);
    if (!variant) throw new Error(`Variant not found: ${line.variantId}`);

    const orderedQty = Number(line.orderedQty !== undefined ? line.orderedQty : line.qty);
    if (!Number.isInteger(orderedQty) || orderedQty <= 0) {
      throw new Error(`Validation Error: Ordered quantity must be a strictly positive integer for variant ${line.variantId}`);
    }

    const unitCostCentimes = BigInt(line.unitCostCentimes !== undefined ? line.unitCostCentimes : (line.costPriceCentimes || variant.cost_price || 0n));
    if (unitCostCentimes < 0n) {
      throw new Error(`Validation Error: Unit cost cannot be negative for variant ${line.variantId}`);
    }

    const lineTotalCentimes = BigInt(orderedQty) * unitCostCentimes;
    totalAmountCentimes += lineTotalCentimes;

    validatedLines.push({
      variantId: line.variantId,
      orderedQty,
      unitCostCentimes,
      lineTotalCentimes
    });
  }

  // INV-05-01: PO creation does NOT touch stock_levels or stock_movements!
  const po = await tx.insert('purchase_orders', {
    po_number: poNumber,
    supplier_id: supplierId,
    location_id: locationId,
    status,
    total_amount_centimes: totalAmountCentimes,
    ordered_at: new Date().toISOString(),
    expected_date: expectedDate,
    notes,
    created_by: createdBy
  });

  const createdLines = [];
  for (const vLine of validatedLines) {
    const pl = await tx.insert('purchase_lines', {
      purchase_order_id: po.id,
      variant_id: vLine.variantId,
      ordered_qty: vLine.orderedQty,
      received_qty: 0,
      returned_qty: 0,
      unit_cost_centimes: vLine.unitCostCentimes,
      line_total_centimes: vLine.lineTotalCentimes
    });
    createdLines.push(pl);
  }

  await tx.insert('audit_logs', {
    action: 'PURCHASE_ORDER_CREATED',
    actor_id: createdBy,
    entity_type: 'purchase_orders',
    entity_id: po.id,
    details: {
      poNumber,
      supplierId,
      status,
      linesCount: createdLines.length,
      totalAmountCentimes: totalAmountCentimes.toString()
    }
  });

  return {
    ...po,
    lines: createdLines
  };
}

// --- Goods Receiving ---

async function receiveGoods(tx, {
  purchaseOrderId,
  locationId,
  receivedLines,
  receivedBy = null,
  operationId = null,
  notes = null
}) {
  if (!purchaseOrderId) throw new Error('Validation Error: purchaseOrderId is required');
  if (!Array.isArray(receivedLines) || receivedLines.length === 0) {
    throw new Error('Validation Error: Received lines must be a non-empty array');
  }

  // INV-05-08: Financial idempotency check
  if (operationId) {
    const existingReceipts = await tx.query('purchase_receipts', r => r.operation_id === operationId);
    if (existingReceipts.length > 0) {
      const receipt = existingReceipts[0];
      const lines = await tx.query('purchase_receipt_lines', rl => rl.purchase_receipt_id === receipt.id);
      return { receipt, lines, replayed: true };
    }
  }

  const po = await tx.findById('purchase_orders', purchaseOrderId);
  if (!po) throw new Error(`Purchase order not found: ${purchaseOrderId}`);

  if (po.status === PO_STATUSES.CANCELLED) {
    throw new Error('Cannot receive goods against a CANCELLED purchase order');
  }
  if (po.status === PO_STATUSES.RECEIVED) {
    throw new Error('Cannot receive goods against an already fully RECEIVED purchase order');
  }

  const targetLocationId = locationId || po.location_id;
  const location = await tx.findById('inventory_locations', targetLocationId);
  if (!location) throw new Error(`Location not found: ${targetLocationId}`);

  // Fetch existing PO lines
  const existingLines = await tx.query('purchase_lines', l => l.purchase_order_id === purchaseOrderId);
  const lineMap = new Map(existingLines.map(l => [l.id, l]));

  // Validation pass: ensure all lines exist, quantities are valid, and ceiling is respected (INV-05-03)
  let totalReceiptCostCentimes = 0n;
  const validatedReceiving = [];

  for (const item of receivedLines) {
    let poLine = null;
    if (item.purchaseLineId) {
      poLine = lineMap.get(item.purchaseLineId);
    } else if (item.variantId) {
      poLine = existingLines.find(l => l.variant_id === item.variantId);
    }

    if (!poLine) {
      throw new Error(`Purchase order line not found for variant ${item.variantId || 'unknown'}`);
    }

    const receivedQty = Number(item.receivedQty !== undefined ? item.receivedQty : item.qty);
    if (!Number.isInteger(receivedQty) || receivedQty <= 0) {
      throw new Error(`Validation Error: Received quantity must be a strictly positive integer`);
    }

    // Invariant INV-05-03: Received quantity cannot exceed ordered quantity
    const newTotalReceived = poLine.received_qty + receivedQty;
    if (newTotalReceived > poLine.ordered_qty) {
      throw new Error(`Invariant Violation INV-05-03: Received quantity (${newTotalReceived}) exceeds ordered quantity (${poLine.ordered_qty}) for line ${poLine.id}`);
    }

    const unitCostCentimes = BigInt(item.unitCostCentimes !== undefined ? item.unitCostCentimes : poLine.unit_cost_centimes);
    if (unitCostCentimes < 0n) {
      throw new Error('Validation Error: Unit cost cannot be negative');
    }

    const lineTotalCentimes = BigInt(receivedQty) * unitCostCentimes;
    totalReceiptCostCentimes += lineTotalCentimes;

    validatedReceiving.push({
      poLine,
      receivedQty,
      unitCostCentimes,
      lineTotalCentimes
    });
  }

  const receiptNumber = `PR-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;

  const receipt = await tx.insert('purchase_receipts', {
    receipt_number: receiptNumber,
    purchase_order_id: purchaseOrderId,
    supplier_id: po.supplier_id,
    location_id: targetLocationId,
    received_at: new Date().toISOString(),
    received_by: receivedBy,
    total_cost_centimes: totalReceiptCostCentimes,
    operation_id: operationId,
    notes
  });

  const createdReceiptLines = [];

  for (const item of validatedReceiving) {
    const { poLine, receivedQty, unitCostCentimes, lineTotalCentimes } = item;

    // 1. Insert receipt line snapshot (INV-05-04)
    const receiptLine = await tx.insert('purchase_receipt_lines', {
      purchase_receipt_id: receipt.id,
      purchase_line_id: poLine.id,
      variant_id: poLine.variant_id,
      received_qty: receivedQty,
      unit_cost_centimes: unitCostCentimes,
      line_total_centimes: lineTotalCentimes
    });
    createdReceiptLines.push(receiptLine);

    // 2. Update PO line received count
    await tx.update('purchase_lines', poLine.id, {
      received_qty: poLine.received_qty + receivedQty
    });

    // 3. Update moving weighted average cost in catalog
    await defaultCostingService.applyReceiptCost(tx, {
      variantId: poLine.variant_id,
      incomingQty: receivedQty,
      incomingUnitCostCentimes: unitCostCentimes
    });

    // 4. INV-05-02: Mutate stock strictly through InventoryService.receiveStock
    await receiveStock(tx, {
      variantId: poLine.variant_id,
      locationId: targetLocationId,
      quantity: receivedQty,
      unitCostCentimes,
      referenceType: 'PURCHASE_RECEIPT',
      referenceId: receipt.id,
      actorId: receivedBy,
      operationId: operationId ? `${operationId}:item:${poLine.id}` : null,
      reason: MOVEMENT_REASONS.RECEIVING
    });
  }

  // Determine updated PO status
  const refreshedLines = await tx.query('purchase_lines', l => l.purchase_order_id === purchaseOrderId);
  const allFulfilled = refreshedLines.every(l => l.received_qty >= l.ordered_qty);
  const newStatus = allFulfilled ? PO_STATUSES.RECEIVED : PO_STATUSES.PARTIALLY_RECEIVED;

  await tx.update('purchase_orders', purchaseOrderId, {
    status: newStatus
  });

  // Record Financial Entry for the goods receipt liability (INV-05-12)
  await tx.insert('financial_entries', {
    entry_type: 'PURCHASE_RECEIVED',
    amount_centimes: totalReceiptCostCentimes,
    reference_type: 'PURCHASE_RECEIPT',
    reference_id: receipt.id,
    supplier_id: po.supplier_id,
    location_id: targetLocationId,
    actor_id: receivedBy,
    entry_date: new Date().toISOString().split('T')[0],
    metadata: {
      receiptNumber,
      purchaseOrderId,
      poNumber: po.po_number
    }
  });

  await tx.insert('audit_logs', {
    action: 'GOODS_RECEIVED',
    actor_id: receivedBy,
    entity_type: 'purchase_receipts',
    entity_id: receipt.id,
    details: {
      receiptNumber,
      purchaseOrderId,
      newStatus,
      totalCostCentimes: totalReceiptCostCentimes.toString()
    }
  });

  return {
    receipt,
    lines: createdReceiptLines,
    purchaseOrderStatus: newStatus,
    replayed: false
  };
}

// --- Returns to Supplier ---

async function returnGoodsToSupplier(tx, {
  purchaseOrderId,
  locationId,
  returnLines,
  returnedBy = null,
  reason = 'DAMAGED_OR_DEFECTIVE',
  operationId = null,
  notes = null
}) {
  if (!purchaseOrderId) throw new Error('Validation Error: purchaseOrderId is required');
  if (!Array.isArray(returnLines) || returnLines.length === 0) {
    throw new Error('Validation Error: Return lines must be a non-empty array');
  }

  // INV-05-08: Financial idempotency check
  if (operationId) {
    const existingReturns = await tx.query('purchase_returns', r => r.operation_id === operationId);
    if (existingReturns.length > 0) {
      const returnRecord = existingReturns[0];
      const lines = await tx.query('purchase_return_lines', rl => rl.purchase_return_id === returnRecord.id);
      return { returnRecord, lines, replayed: true };
    }
  }

  const po = await tx.findById('purchase_orders', purchaseOrderId);
  if (!po) throw new Error(`Purchase order not found: ${purchaseOrderId}`);

  const targetLocationId = locationId || po.location_id;
  const location = await tx.findById('inventory_locations', targetLocationId);
  if (!location) throw new Error(`Location not found: ${targetLocationId}`);

  const existingLines = await tx.query('purchase_lines', l => l.purchase_order_id === purchaseOrderId);
  const lineMap = new Map(existingLines.map(l => [l.id, l]));

  let totalReturnCentimes = 0n;
  const validatedReturns = [];

  for (const item of returnLines) {
    let poLine = null;
    if (item.purchaseLineId) {
      poLine = lineMap.get(item.purchaseLineId);
    } else if (item.variantId) {
      poLine = existingLines.find(l => l.variant_id === item.variantId);
    }

    if (!poLine) {
      throw new Error(`Purchase order line not found for variant ${item.variantId || 'unknown'}`);
    }

    const returnedQty = Number(item.returnedQty !== undefined ? item.returnedQty : item.qty);
    if (!Number.isInteger(returnedQty) || returnedQty <= 0) {
      throw new Error('Validation Error: Return quantity must be a strictly positive integer');
    }

    // Invariant INV-05-10: Return quantity cannot exceed received quantity minus already returned
    const maxReturnable = poLine.received_qty - poLine.returned_qty;
    if (returnedQty > maxReturnable) {
      throw new Error(`Invariant Violation INV-05-10: Return quantity (${returnedQty}) exceeds remaining returnable quantity (${maxReturnable}) for line ${poLine.id}`);
    }

    const unitCostCentimes = BigInt(poLine.unit_cost_centimes);
    const lineTotalCentimes = BigInt(returnedQty) * unitCostCentimes;
    totalReturnCentimes += lineTotalCentimes;

    validatedReturns.push({
      poLine,
      returnedQty,
      unitCostCentimes,
      lineTotalCentimes
    });
  }

  const returnNumber = `PRT-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;

  const returnRecord = await tx.insert('purchase_returns', {
    return_number: returnNumber,
    purchase_order_id: purchaseOrderId,
    supplier_id: po.supplier_id,
    location_id: targetLocationId,
    returned_at: new Date().toISOString(),
    returned_by: returnedBy,
    total_return_centimes: totalReturnCentimes,
    reason,
    operation_id: operationId,
    notes
  });

  const createdReturnLines = [];

  for (const item of validatedReturns) {
    const { poLine, returnedQty, unitCostCentimes, lineTotalCentimes } = item;

    // 1. Insert return line
    const returnLine = await tx.insert('purchase_return_lines', {
      purchase_return_id: returnRecord.id,
      purchase_line_id: poLine.id,
      variant_id: poLine.variant_id,
      returned_qty: returnedQty,
      unit_cost_centimes: unitCostCentimes,
      line_total_centimes: lineTotalCentimes
    });
    createdReturnLines.push(returnLine);

    // 2. Update line returned count
    await tx.update('purchase_lines', poLine.id, {
      returned_qty: poLine.returned_qty + returnedQty
    });

    // 3. Deduct inventory via InventoryService
    await issueStock(tx, {
      variantId: poLine.variant_id,
      locationId: targetLocationId,
      quantity: returnedQty,
      costPriceCentimes: unitCostCentimes,
      referenceType: 'PURCHASE_RETURN',
      referenceId: returnRecord.id,
      actorId: returnedBy,
      operationId: operationId ? `${operationId}:item:${poLine.id}` : null,
      reason: MOVEMENT_REASONS.PURCHASE_RETURN,
      movementType: MOVEMENT_TYPES.PURCHASE_RETURN
    });
  }

  // Record Financial Entry reducing supplier liability (INV-05-12)
  await tx.insert('financial_entries', {
    entry_type: 'PURCHASE_RETURN',
    amount_centimes: totalReturnCentimes,
    reference_type: 'PURCHASE_RETURN',
    reference_id: returnRecord.id,
    supplier_id: po.supplier_id,
    location_id: targetLocationId,
    actor_id: returnedBy,
    entry_date: new Date().toISOString().split('T')[0],
    metadata: {
      returnNumber,
      purchaseOrderId,
      reason
    }
  });

  await tx.insert('audit_logs', {
    action: 'PURCHASE_RETURN_CREATED',
    actor_id: returnedBy,
    entity_type: 'purchase_returns',
    entity_id: returnRecord.id,
    details: {
      returnNumber,
      purchaseOrderId,
      totalReturnCentimes: totalReturnCentimes.toString()
    }
  });

  return {
    returnRecord,
    lines: createdReturnLines,
    replayed: false
  };
}

module.exports = {
  PO_STATUSES,
  createSupplier,
  updateSupplier,
  getSupplier,
  listSuppliers,
  createPurchaseOrder,
  receiveGoods,
  returnGoodsToSupplier
};
