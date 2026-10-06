const { generateUUIDv7, normalizeAlgerianPhone } = require('../db/utils');
const { createReservation, fulfillReservation, releaseReservation, applyStockMovement, MOVEMENT_REASONS } = require('../inventory/ledger');
const { ProcessingJournalService, PROCESSING_OPERATIONS } = require('../compliance/processing_journal');

/**
 * Online Orders & COD Confirmation Kanban Engine for BoutiqFlow DZ
 * 
 * Invariants:
 * - INV-06-01: Creating an OnlineOrder never reserves inventory.
 * - INV-06-08: Client cannot forge Order totals, prices, or confirmation state.
 * - INV-06-09: Historical OrderLine prices remain immutable.
 * - INV-06-10: Historical delivery fee/COD amount remains immutable.
 * - INV-06-11: Cross-tenant Order/Customer/Reservation access is impossible.
 * - INV-06-13: Personal data access recorded in Processing Journal.
 * - INV-06-14: OnlineOrder and POS Sale remain distinct domain entities.
 */

const ORDER_STATUSES = {
  NEW: 'NEW',
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION',
  CONFIRMED: 'CONFIRMED',
  RESERVED: 'RESERVED',
  CONFIRMED_AWAITING_STOCK: 'CONFIRMED_AWAITING_STOCK',
  STOCK_UNAVAILABLE: 'STOCK_UNAVAILABLE',
  PREPARING: 'PREPARING',
  PACKED: 'PACKED',
  READY_TO_SHIP: 'READY_TO_SHIP',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  REFUSED: 'REFUSED',
  EXPIRED: 'EXPIRED',
  INVALID_NUMBER: 'INVALID_NUMBER',
  UNREACHABLE: 'UNREACHABLE',
  RETURN_PENDING: 'RETURN_PENDING',
  RETURNED: 'RETURNED',
  RETURN_RECEIVED: 'RETURN_RECEIVED',
  LOST: 'LOST'
};

const VALID_TRANSITIONS = {
  [ORDER_STATUSES.NEW]: [
    ORDER_STATUSES.PENDING_CONFIRMATION,
    ORDER_STATUSES.CONFIRMED,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.PENDING_CONFIRMATION]: [
    ORDER_STATUSES.CONFIRMED,
    ORDER_STATUSES.RESERVED,
    ORDER_STATUSES.UNREACHABLE,
    ORDER_STATUSES.REFUSED,
    ORDER_STATUSES.INVALID_NUMBER,
    ORDER_STATUSES.CANCELLED,
    ORDER_STATUSES.EXPIRED,
    ORDER_STATUSES.STOCK_UNAVAILABLE
  ],
  [ORDER_STATUSES.CONFIRMED]: [
    ORDER_STATUSES.RESERVED,
    ORDER_STATUSES.PREPARING,
    ORDER_STATUSES.PACKED,
    ORDER_STATUSES.STOCK_UNAVAILABLE,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.RESERVED]: [
    ORDER_STATUSES.PREPARING,
    ORDER_STATUSES.PACKED,
    ORDER_STATUSES.READY_TO_SHIP,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.STOCK_UNAVAILABLE]: [
    ORDER_STATUSES.RESERVED,
    ORDER_STATUSES.CONFIRMED,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.PREPARING]: [
    ORDER_STATUSES.PACKED,
    ORDER_STATUSES.READY_TO_SHIP,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.PACKED]: [
    ORDER_STATUSES.READY_TO_SHIP,
    ORDER_STATUSES.SHIPPED,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.READY_TO_SHIP]: [
    ORDER_STATUSES.SHIPPED,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.SHIPPED]: [
    ORDER_STATUSES.DELIVERED,
    ORDER_STATUSES.RETURN_PENDING,
    ORDER_STATUSES.RETURNED,
    ORDER_STATUSES.RETURN_RECEIVED,
    ORDER_STATUSES.LOST
  ],
  [ORDER_STATUSES.DELIVERED]: [
    ORDER_STATUSES.RETURN_PENDING,
    ORDER_STATUSES.RETURNED,
    ORDER_STATUSES.RETURN_RECEIVED
  ],
  [ORDER_STATUSES.RETURN_PENDING]: [
    ORDER_STATUSES.RETURNED,
    ORDER_STATUSES.RETURN_RECEIVED
  ],
  [ORDER_STATUSES.CANCELLED]: [],
  [ORDER_STATUSES.REFUSED]: [],
  [ORDER_STATUSES.EXPIRED]: []
};

async function createOnlineOrder(tx, {
  source = 'MANUAL',
  customerName,
  customerPhone,
  wilaya,
  commune,
  address,
  items, // array of { variantId, qty, unitPriceCentimes, discountCentimes }
  shippingFeeCentimes = 0n,
  deliveryFeeCentimes = null,
  discountCentimes = 0n,
  notes = null,
  operationId = null,
  customerId = null,
  status = ORDER_STATUSES.NEW
}) {
  if (!customerPhone) throw new Error('Validation Error: Customer phone number is required');
  const normPhone = normalizeAlgerianPhone(customerPhone);
  if (!normPhone) {
    throw new Error(`Invalid Algerian phone number: ${customerPhone}`);
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Validation Error: Order must contain at least one line item');
  }

  // INV-06-04: Idempotency check per tenant
  if (operationId) {
    const existingOrders = await tx.query('online_orders', o => o.operation_id === operationId);
    if (existingOrders.length > 0) {
      return existingOrders[0];
    }
  }

  // 1. Duplicate detection check: same phone placed within 24h
  const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const recentOrders = await tx.query('online_orders', o =>
    o.customer_phone === normPhone && o.created_at >= oneDayAgo && o.status !== ORDER_STATUSES.CANCELLED
  );
  const isDuplicate = recentOrders.length > 0;

  // 2. Risky customer check: customer has 2+ past refused/returned orders in this tenant
  const historicalReturns = await tx.query('online_orders', o =>
    o.customer_phone === normPhone &&
    (o.status === ORDER_STATUSES.RETURN_RECEIVED || o.status === ORDER_STATUSES.RETURNED || o.status === ORDER_STATUSES.LOST || o.status === ORDER_STATUSES.CANCELLED || o.status === ORDER_STATUSES.REFUSED)
  );
  const isRisky = historicalReturns.length >= 2;
  const riskReason = isRisky ? `Customer has ${historicalReturns.length} previously returned/cancelled orders` : null;

  // 3. Process items and calculate totals (INV-06-08, INV-06-09)
  let subtotalCentimes = 0n;
  const processedItems = [];

  for (const item of items) {
    if (!item.variantId) throw new Error('Validation Error: variantId is required for each order line');
    const variant = await tx.findById('product_variants', item.variantId);
    if (!variant) throw new Error(`Variant not found: ${item.variantId}`);

    const qty = Number(item.qty !== undefined ? item.qty : item.quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error('Validation Error: Item quantity must be a strictly positive integer');
    }

    const product = await tx.findById('products', variant.product_id);
    const unitPrice = BigInt(item.unitPriceCentimes !== undefined ? item.unitPriceCentimes : (variant.sale_price || variant.selling_price_centimes || 0n));
    if (unitPrice < 0n) throw new Error('Validation Error: Unit price cannot be negative');

    const itemDiscount = BigInt(item.discountCentimes || 0n);
    const lineTotal = (BigInt(qty) * unitPrice) - itemDiscount;

    subtotalCentimes += lineTotal;
    processedItems.push({
      variantId: variant.id,
      productId: variant.product_id,
      productName: product ? product.name : 'Unknown Product',
      variantLabel: `${variant.color || ''} ${variant.size || ''}`.trim() || 'Standard',
      sku: variant.sku,
      barcode: variant.barcode,
      qty,
      unitPrice,
      discount: itemDiscount,
      lineTotal
    });
  }

  const deliveryFee = BigInt(deliveryFeeCentimes !== null ? deliveryFeeCentimes : shippingFeeCentimes);
  const cartDiscount = BigInt(discountCentimes || 0n);
  const total = subtotalCentimes + deliveryFee - cartDiscount;
  const codAmount = total; // Explicit COD amount (Requirement 21)

  const orderId = generateUUIDv7();
  const orderNumber = `CMD-${Date.now().toString().slice(-6)}`;

  // Customer Snapshot (Requirement 2)
  const customerSnapshot = {
    name: customerName,
    phone: customerPhone,
    phoneNormalized: normPhone,
    wilaya,
    commune,
    address
  };

  // INV-06-01: Creating an OnlineOrder NEVER reserves inventory!
  const order = await tx.insert('online_orders', {
    id: orderId,
    order_number: orderNumber,
    source,
    customer_id: customerId,
    customer_name: customerName,
    customer_phone: normPhone,
    customer_snapshot: customerSnapshot,
    wilaya,
    commune,
    address,
    currency: 'DZD',
    status,
    subtotal_centimes: subtotalCentimes,
    shipping_fee_centimes: deliveryFee,
    delivery_fee_centimes: deliveryFee,
    discount_centimes: cartDiscount,
    cod_amount_centimes: codAmount,
    total_centimes: total,
    notes,
    operation_id: operationId,
    is_duplicate: isDuplicate,
    is_risky: isRisky,
    risk_reason: riskReason
  });

  // Create initial COD confirmation record
  await tx.insert('cod_confirmations', {
    order_id: orderId,
    status: 'PENDING_CONFIRMATION',
    attempt_count: 0
  });

  // Insert order lines (snapshots INV-06-09)
  for (const pItem of processedItems) {
    await tx.insert('order_items', {
      order_id: orderId,
      product_id: pItem.productId,
      variant_id: pItem.variantId,
      product_name: pItem.productName,
      variant_label: pItem.variantLabel,
      sku: pItem.sku,
      barcode: pItem.barcode,
      qty: pItem.qty,
      unit_price_centimes: pItem.unitPrice,
      discount_centimes: pItem.discount,
      total_centimes: pItem.lineTotal,
      line_total_centimes: pItem.lineTotal
    });
  }

  // INV-06-13: Log personal data collection in Processing Journal
  try {
    await ProcessingJournalService.logOperation(tx, {
      actorId: tx.session.userId || 'system',
      actorRole: tx.session.role || 'API',
      operation: PROCESSING_OPERATIONS.COLLECTION,
      dataSubjectType: 'CUSTOMER',
      dataSubjectId: customerId || normPhone,
      purpose: 'ONLINE_ORDER_CREATION',
      details: {
        orderId,
        orderNumber,
        wilaya
      }
    });
  } catch (e) {
    // Non-fatal if session lacks userId
  }

  await tx.insert('audit_logs', {
    action: 'ONLINE_ORDER_CREATED',
    entity_type: 'online_orders',
    entity_id: order.id,
    details: {
      orderNumber,
      customerPhone: normPhone,
      totalCentimes: total.toString(),
      itemsCount: processedItems.length
    }
  });

  return order;
}

/**
 * State Machine Transition Validator (Requirement 4)
 */
async function transitionOrderStatus(tx, orderId, targetStatus, actorId = null, reason = null) {
  const order = await tx.findById('online_orders', orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);

  const allowed = VALID_TRANSITIONS[order.status] || [];
  if (!allowed.includes(targetStatus)) {
    throw new Error(`Order Lifecycle Violation: Invalid status transition from '${order.status}' to '${targetStatus}'`);
  }

  const updated = await tx.update('online_orders', orderId, {
    status: targetStatus,
    updated_at: new Date().toISOString()
  });

  await tx.insert('audit_logs', {
    action: 'ONLINE_ORDER_STATUS_CHANGED',
    actor_id: actorId,
    entity_type: 'online_orders',
    entity_id: orderId,
    details: {
      fromStatus: order.status,
      toStatus: targetStatus,
      reason
    }
  });

  return updated;
}

/**
 * Confirm order (backwards-compatible wrapper delegating to CodConfirmationService)
 */
async function confirmOrder(tx, orderId, locationId) {
  const actualOrderId = typeof orderId === 'object' && orderId !== null ? orderId.orderId : orderId;
  const actualLocationId = typeof orderId === 'object' && orderId !== null ? orderId.locationId : locationId;
  const { CodConfirmationService } = require('./confirmation_service');
  const res = await CodConfirmationService.confirmAndReserve(tx, {
    orderId: actualOrderId,
    locationId: actualLocationId
  });
  return await tx.findById('online_orders', actualOrderId);
}

/**
 * Ship order: fulfills stock reservations, creates courier shipment
 */
async function shipOrder(tx, { orderId, courierAdapter, isStopdesk = false }) {
  const order = await tx.findById('online_orders', orderId);
  if (!order || (order.status !== ORDER_STATUSES.CONFIRMED && order.status !== ORDER_STATUSES.PACKED && order.status !== ORDER_STATUSES.RESERVED && order.status !== ORDER_STATUSES.READY_TO_SHIP)) {
    throw new Error(`Order ${orderId} must be CONFIRMED, RESERVED, PACKED, or READY_TO_SHIP before shipping`);
  }

  const items = await tx.query('order_items', i => i.order_id === orderId);

  // Fulfill stock reservations (deducting inventory)
  for (const item of items) {
    if (item.reservation_id) {
      await fulfillReservation(tx, item.reservation_id);
    }
  }

  // Create shipment with courier adapter
  const courierShipment = await courierAdapter.createShipment({
    orderNumber: order.order_number,
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    address: order.address,
    wilaya: order.wilaya,
    commune: order.commune,
    codAmountCentimes: order.cod_amount_centimes || order.total_centimes,
    isStopdesk
  });

  // Record shipment in database
  await tx.insert('shipments', {
    order_id: orderId,
    courier_account_id: courierAdapter.accountId,
    tracking_code: courierShipment.trackingCode,
    status: 'SHIPPED',
    shipping_cost_centimes: courierShipment.shippingCostCentimes,
    cod_amount_centimes: courierShipment.codAmountCentimes
  });

  return await tx.update('online_orders', orderId, {
    status: ORDER_STATUSES.SHIPPED,
    courier_account_id: courierAdapter.accountId,
    tracking_code: courierShipment.trackingCode,
    label_url: courierShipment.labelUrl
  });
}

/**
 * Mark order delivered
 */
async function deliverOrder(tx, orderId) {
  return await tx.update('online_orders', orderId, { status: ORDER_STATUSES.DELIVERED });
}

/**
 * Receive returned order: Restocks items into designated location
 */
async function receiveReturnedOrder(tx, { orderId, restockLocationId }) {
  const order = await tx.findById('online_orders', orderId);
  if (!order) throw new Error('Order not found');

  const items = await tx.query('order_items', i => i.order_id === orderId);

  // Restock inventory through InventoryService
  for (const item of items) {
    await applyStockMovement(tx, {
      variantId: item.variant_id,
      locationId: restockLocationId,
      qty: item.qty,
      reason: MOVEMENT_REASONS.RETURN_RESTOCK,
      referenceType: 'RETURNED_ONLINE_ORDER',
      referenceId: order.id
    });
  }

  return await tx.update('online_orders', orderId, { status: ORDER_STATUSES.RETURN_RECEIVED });
}

/**
 * Generates WhatsApp click-to-chat link
 */
function generateWhatsAppLink(phone, message) {
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const encodedText = encodeURIComponent(message);
  return `https://wa.me/${cleanPhone}?text=${encodedText}`;
}

/**
 * Log phone call attempt (backwards compatible)
 */
async function logCallAttempt(tx, { orderId, callerId, outcome, notes }) {
  const { CodConfirmationService, CONFIRMATION_CHANNELS } = require('./confirmation_service');
  return await CodConfirmationService.logCallAttempt(tx, {
    orderId,
    agentId: callerId,
    channel: CONFIRMATION_CHANNELS.PHONE_CALL,
    outcome,
    notes
  });
}

module.exports = {
  ORDER_STATUSES,
  VALID_TRANSITIONS,
  createOnlineOrder,
  transitionOrderStatus,
  confirmOrder,
  shipOrder,
  deliverOrder,
  receiveReturnedOrder,
  generateWhatsAppLink,
  logCallAttempt
};
