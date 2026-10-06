const { AsyncLocalStorage } = require('node:async_hooks');
const { generateUUIDv7 } = require('../db/utils');

/**
 * BoutiqFlow DZ — Authoritative Central Inventory Ledger Engine (Phase 03)
 * Implements Mandatory Invariants:
 * - INV-03-01: onHand >= 0 (negative stock strictly forbidden by default)
 * - INV-03-02: reserved >= 0
 * - INV-03-03: reserved <= onHand
 * - INV-03-04: available = onHand - reserved (authoritative derived quantity)
 * - INV-03-05: Every stock mutation creates exactly one authoritative ledger event
 * - INV-03-06: Ledger events are immutable (no UPDATE/DELETE on stock_movements)
 * - INV-03-07: Reservation release is idempotent
 * - INV-03-08: Reservation consumption is idempotent
 * - INV-03-09: Duplicate operationId cannot duplicate mutation
 * - INV-03-10: Concurrent operations cannot oversell (serialized via re-entrant mutex locks)
 * - INV-03-11: Cross-tenant inventory access is impossible
 * - INV-03-12: Historical stock mutations remain auditable
 * - INV-03-13: No external domain directly mutates inventory
 * - INV-03-14: Failed atomic operation leaves no partial stock mutation
 */

const MOVEMENT_TYPES = {
  RECEIPT: 'RECEIPT',
  SALE: 'SALE',
  ADJUSTMENT_IN: 'ADJUSTMENT_IN',
  ADJUSTMENT_OUT: 'ADJUSTMENT_OUT',
  RETURN: 'RETURN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  TRANSFER_IN: 'TRANSFER_IN',
  RESERVATION: 'RESERVATION',
  RESERVATION_RELEASE: 'RESERVATION_RELEASE',
  PURCHASE_RETURN: 'PURCHASE_RETURN'
};

// Backwards compatibility taxonomy mapping
const MOVEMENT_REASONS = {
  RECEIVING: 'RECEIVING',
  POS_SALE: 'POS_SALE',
  ONLINE_SHIPMENT: 'ONLINE_SHIPMENT',
  RETURN_RESTOCK: 'RETURN_RESTOCK',
  TRANSFER_IN: 'TRANSFER_IN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  ADJUSTMENT: 'ADJUSTMENT',
  STOCKTAKE_ADJUSTMENT: 'STOCKTAKE_ADJUSTMENT',
  OPENING_BALANCE: 'OPENING_BALANCE',
  PURCHASE_RETURN: 'PURCHASE_RETURN',
  SUPPLIER_RETURN: 'SUPPLIER_RETURN'
};

const RESERVATION_STATUSES = {
  ACTIVE: 'ACTIVE',
  RELEASED: 'RELEASED',
  CONSUMED: 'CONSUMED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED'
};

const ADJUSTMENT_REASONS = {
  DAMAGED: 'DAMAGED',
  LOST: 'LOST',
  COUNT_CORRECTION: 'COUNT_CORRECTION',
  FOUND: 'FOUND',
  INITIAL_STOCK: 'INITIAL_STOCK',
  OTHER: 'OTHER'
};

const TRANSFER_STATUSES = {
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
};

const fs = require('fs');
const path = require('path');
const os = require('os');
const DISTRIBUTED_LOCK_DIR = path.join(os.tmpdir(), 'boutiqflow_inventory_locks');

function acquireDistributedFileLock(key) {
  try { fs.mkdirSync(DISTRIBUTED_LOCK_DIR, { recursive: true }); } catch (e) {}
  const lockFilePath = path.join(DISTRIBUTED_LOCK_DIR, encodeURIComponent(key) + '.lock');
  const start = Date.now();
  const timeoutMs = 15000;
  while (true) {
    try {
      const fd = fs.openSync(lockFilePath, 'wx');
      fs.writeSync(fd, String(process.pid));
      return () => {
        try { fs.closeSync(fd); } catch (e) {}
        try { fs.unlinkSync(lockFilePath); } catch (e) {}
      };
    } catch (err) {
      if (err.code === 'EEXIST') {
        if (Date.now() - start > timeoutMs) {
          throw new Error('Distributed Lock Timeout for key: ' + key);
        }
        const wait = Date.now() + 5;
        while (Date.now() < wait) {}
      } else {
        throw err;
      }
    }
  }
}

// --- In-Memory Re-Entrant Mutex Lock for Concurrency Control (INV-03-10) ---
const lockStorage = new AsyncLocalStorage();
const activeLocks = new Map();

async function acquireLock(key, contextId) {
  while (activeLocks.has(key)) {
    const current = activeLocks.get(key);
    if (current.contextId === contextId) {
      // Re-entrant lock in same async execution context
      current.refCount++;
      return () => {
        current.refCount--;
        if (current.refCount <= 0) {
          activeLocks.delete(key);
          current.release();
        }
      };
    }
    await current.promise;
  }

  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  const lockInfo = { contextId, refCount: 1, promise, release };
  activeLocks.set(key, lockInfo);

  return () => {
    lockInfo.refCount--;
    if (lockInfo.refCount <= 0) {
      activeLocks.delete(key);
      release();
    }
  };
}

async function withInventoryLocks(keys, fn) {
  const contextId = lockStorage.getStore() || generateUUIDv7();
  return lockStorage.run(contextId, async () => {
    const sortedKeys = [...new Set(keys)].sort();
    const releases = [];
    for (const key of sortedKeys) {
      if (process.env.BOUTIQFLOW_DISTRIBUTED_LOCK === '1') {
        const fileRelease = acquireDistributedFileLock(key);
        releases.push(fileRelease);
      }
      const release = await acquireLock(key, contextId);
      releases.push(release);
    }
    try {
      return await fn();
    } finally {
      for (const release of releases.reverse()) {
        release();
      }
    }
  });
}

// --- Authority Execution Wrapper (INV-03-13) ---
async function runWithInventoryAuthority(tx, fn) {
  const previous = tx.isInventoryAuthoritative;
  tx.isInventoryAuthoritative = true;
  try {
    return await fn();
  } finally {
    tx.isInventoryAuthoritative = previous;
  }
}

// --- Tenant & Entity Existence Validation (INV-03-11) ---
async function validateTenantEntities(tx, { variantId, locationId, reservationId }) {
  if (variantId) {
    const variant = await tx.findById('product_variants', variantId);
    if (!variant) {
      throw new Error(`Tenant Isolation Violation: Variant ${variantId} not found or belongs to another tenant (INV-03-11)`);
    }
  }
  if (locationId) {
    const location = await tx.findById('inventory_locations', locationId);
    if (!location) {
      throw new Error(`Tenant Isolation Violation: Location ${locationId} not found or belongs to another tenant (INV-03-11)`);
    }
  }
  if (reservationId) {
    const res = await tx.findById('stock_reservations', reservationId);
    if (!res) {
      throw new Error(`Tenant Isolation Violation: Reservation ${reservationId} not found or belongs to another tenant (INV-03-11)`);
    }
    return res;
  }
  return null;
}

// --- Helper to get or initialize stock level record ---
async function getOrCreateStockLevel(tx, variantId, locationId) {
  return runWithInventoryAuthority(tx, async () => {
    const levels = await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === locationId);
    if (levels.length > 0) {
      return levels[0];
    }
    return await tx.insert('stock_levels', {
      variant_id: variantId,
      location_id: locationId,
      on_hand: 0,
      reserved: 0,
      available: 0
    });
  });
}

// --- Core Stock Mutation Handler with Idempotency & Invariants ---
async function executeStockMutation(tx, {
  variantId,
  locationId,
  quantityDelta,
  reservedDelta = 0,
  movementType,
  costPriceCentimes = 0n,
  referenceType = null,
  referenceId = null,
  operationId = null,
  actorId = null,
  reason = null,
  metadata = {},
  allowNegative = false
}) {
  if (!Number.isInteger(quantityDelta)) {
    throw new Error('Validation Error: Stock quantity delta must be an integer');
  }
  if (!Number.isInteger(reservedDelta)) {
    throw new Error('Validation Error: Reserved quantity delta must be an integer');
  }

  // INV-03-09: Idempotency check per tenant
  if (operationId) {
    const existingKey = await tx.query('idempotency_keys', k => k.key === operationId);
    if (existingKey.length > 0 && existingKey[0].response_data) {
      return existingKey[0].response_data;
    }
  }

  // Validate tenant ownership
  await validateTenantEntities(tx, { variantId, locationId });

  const tenantId = tx.session.tenantId;
  const lockKey = `${tenantId}:${variantId}:${locationId}`;

  return await withInventoryLocks([lockKey], async () => {
    // Re-check idempotency under lock in case concurrent request just finished
    if (operationId) {
      const existingKey = await tx.query('idempotency_keys', k => k.key === operationId);
      if (existingKey.length > 0 && existingKey[0].response_data) {
        return existingKey[0].response_data;
      }
    }

    return await runWithInventoryAuthority(tx, async () => {
      const level = await getOrCreateStockLevel(tx, variantId, locationId);
      const beforeOnHand = level.on_hand;
      const beforeReserved = level.reserved;

      const newOnHand = beforeOnHand + quantityDelta;
      let newReserved = beforeReserved + reservedDelta;

      // Invariant checks
      if (newOnHand < 0 && !allowNegative) {
        throw new Error(`Invariant Violation INV-03-01: Insufficient inventory. on_hand would become negative (${newOnHand}) for variant ${variantId}`);
      }

      // Check available for outbound issue mutations
      if (quantityDelta < 0 && reservedDelta === 0) {
        // Outbound issue / sale
        if (reason !== MOVEMENT_REASONS.POS_SALE && !allowNegative) {
          if (level.available < -quantityDelta) {
            throw new Error(`Invariant Violation INV-03-04: Insufficient available inventory. Requested ${-quantityDelta} but available is only ${level.available} (onHand: ${level.on_hand}, reserved: ${level.reserved}) for variant ${variantId}`);
          }
        } else if (newReserved > newOnHand && !allowNegative) {
          // Physical POS sale on shelf adjusts reserved so reserved <= onHand
          newReserved = Math.max(0, newOnHand);
        }
      } else if (newReserved > newOnHand && !allowNegative) {
        throw new Error(`Invariant Violation INV-03-03: reserved (${newReserved}) cannot exceed on_hand (${newOnHand}) for variant ${variantId}`);
      }

      if (newReserved < 0) {
        throw new Error(`Invariant Violation INV-03-02: reserved cannot be negative (${newReserved}) for variant ${variantId}`);
      }

      const newAvailable = newOnHand - newReserved;
      if (newAvailable < 0 && !allowNegative) {
        throw new Error(`Invariant Violation INV-03-04: available cannot be negative (${newAvailable}) for variant ${variantId}`);
      }

      // 1. Insert authoritative immutable ledger movement (INV-03-05, INV-03-06, INV-03-12)
      let movement = null;
      if (quantityDelta !== 0 || movementType === MOVEMENT_TYPES.RESERVATION || movementType === MOVEMENT_TYPES.RESERVATION_RELEASE) {
        movement = await tx.insert('stock_movements', {
          variant_id: variantId,
          location_id: locationId,
          type: movementType,
          qty: quantityDelta, // for backwards compat
          quantity: quantityDelta,
          cost_price_centimes: BigInt(costPriceCentimes),
          reason: reason || movementType,
          reference_type: referenceType,
          reference_id: referenceId,
          operation_id: operationId,
          actor_id: actorId,
          metadata: {
            beforeOnHand,
            afterOnHand: newOnHand,
            beforeReserved,
            afterReserved: newReserved,
            beforeAvailable: beforeOnHand - beforeReserved,
            afterAvailable: newAvailable,
            reason: reason || movementType,
            ...metadata
          }
        });
      }

      // 2. Update cached stock level
      await tx.update('stock_levels', level.id, {
        on_hand: newOnHand,
        reserved: newReserved,
        available: newAvailable
      });

      const response = {
        movementId: movement ? movement.id : null,
        variantId,
        locationId,
        onHand: newOnHand,
        reserved: newReserved,
        available: newAvailable,
        type: movementType
      };

      // Store idempotency key result if operationId provided
      if (operationId) {
        await tx.insert('idempotency_keys', {
          key: operationId,
          resource_id: movement ? movement.id : level.id,
          response_data: response,
          status_code: 200
        });
      }

      return response;
    });
  });
}

// --- Public Domain Service Methods ---

/**
 * 1. Receive Stock (Purchases / Supplier Goods)
 */
async function receiveStock(tx, params) {
  const variantId = params.variantId;
  const locationId = params.locationId;
  const quantity = params.quantity !== undefined ? params.quantity : params.qty;
  const unitCostCentimes = params.unitCostCentimes !== undefined ? params.unitCostCentimes : (params.costPriceCentimes || 0n);
  const referenceType = params.referenceType || 'PURCHASE';
  const referenceId = params.referenceId || null;
  const operationId = params.operationId || null;
  const actorId = params.actorId || null;
  const metadata = params.metadata || {};

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('Validation Error: Received stock quantity must be a strictly positive integer');
  }

  return await executeStockMutation(tx, {
    variantId,
    locationId,
    quantityDelta: quantity,
    reservedDelta: 0,
    movementType: MOVEMENT_TYPES.RECEIPT,
    costPriceCentimes: unitCostCentimes,
    referenceType,
    referenceId,
    operationId,
    actorId,
    reason: MOVEMENT_REASONS.RECEIVING,
    metadata
  });
}

/**
 * 2. Issue Stock (Sales / Unreserved Outbound Shipments)
 */
async function issueStock(tx, params) {
  const variantId = params.variantId;
  const locationId = params.locationId;
  const quantity = params.quantity !== undefined ? params.quantity : params.qty;
  const costPriceCentimes = params.costPriceCentimes || 0n;
  const referenceType = params.referenceType || 'SALE';
  const referenceId = params.referenceId || null;
  const operationId = params.operationId || null;
  const actorId = params.actorId || null;
  const metadata = params.metadata || {};
  const allowNegative = Boolean(params.allowNegative);
  const reason = params.reason || MOVEMENT_TYPES.SALE;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('Validation Error: Issued stock quantity must be a strictly positive integer');
  }

  return await executeStockMutation(tx, {
    variantId,
    locationId,
    quantityDelta: -quantity,
    reservedDelta: 0,
    movementType: params.movementType || MOVEMENT_TYPES.SALE,
    costPriceCentimes,
    referenceType,
    referenceId,
    operationId,
    actorId,
    reason,
    metadata,
    allowNegative
  });
}

/**
 * 3. Adjust Stock (Inventory Reconciliation with Mandatory Explicit Reasons)
 */
async function adjustStock(tx, params) {
  const variantId = params.variantId;
  const locationId = params.locationId;
  const adjustment = params.adjustment !== undefined ? params.adjustment : (params.quantity !== undefined ? params.quantity : params.qty);
  const reason = params.reason;
  const referenceType = params.referenceType || 'ADJUSTMENT';
  const referenceId = params.referenceId || null;
  const operationId = params.operationId || null;
  const actorId = params.actorId || null;
  const metadata = params.metadata || {};
  const allowNegative = Boolean(params.allowNegative);

  if (!Number.isInteger(adjustment) || adjustment === 0) {
    throw new Error('Validation Error: Stock adjustment delta must be a non-zero integer');
  }
  if (!reason || !ADJUSTMENT_REASONS[reason]) {
    throw new Error(`Validation Error: Invalid stock adjustment reason '${reason}'. Must be one of: ${Object.keys(ADJUSTMENT_REASONS).join(', ')}`);
  }

  const movementType = adjustment > 0 ? MOVEMENT_TYPES.ADJUSTMENT_IN : MOVEMENT_TYPES.ADJUSTMENT_OUT;

  return await executeStockMutation(tx, {
    variantId,
    locationId,
    quantityDelta: adjustment,
    reservedDelta: 0,
    movementType,
    costPriceCentimes: 0n,
    referenceType,
    referenceId,
    operationId,
    actorId,
    reason,
    metadata: {
      adjustmentReason: reason,
      ...metadata
    },
    allowNegative
  });
}

/**
 * 4. Reserve Stock (First-Class Reservation Domain)
 */
async function reserveStock(tx, params) {
  const variantId = params.variantId;
  const locationId = params.locationId;
  const quantity = params.quantity !== undefined ? params.quantity : params.qty;
  const orderId = params.orderId || null;
  const ttlMinutes = params.ttlMinutes || 60;
  const operationId = params.operationId || null;
  const actorId = params.actorId || null;
  const metadata = params.metadata || {};

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('Validation Error: Reservation quantity must be a strictly positive integer');
  }

  // Idempotency check (INV-03-09)
  if (operationId) {
    const existingKey = await tx.query('idempotency_keys', k => k.key === operationId);
    if (existingKey.length > 0 && existingKey[0].response_data) {
      return existingKey[0].response_data;
    }
  }

  // Validate tenant boundary
  await validateTenantEntities(tx, { variantId, locationId });

  const tenantId = tx.session.tenantId;
  const lockKey = `${tenantId}:${variantId}:${locationId}`;

  return await withInventoryLocks([lockKey], async () => {
    if (operationId) {
      const existingKey = await tx.query('idempotency_keys', k => k.key === operationId);
      if (existingKey.length > 0 && existingKey[0].response_data) {
        return existingKey[0].response_data;
      }
    }

    return await runWithInventoryAuthority(tx, async () => {
      const level = await getOrCreateStockLevel(tx, variantId, locationId);
      if (level.available < quantity) {
        throw new Error(`Cannot reserve: requested ${quantity} but available is only ${level.available}`);
      }

      const newReserved = level.reserved + quantity;
      const newAvailable = level.on_hand - newReserved;

      const reservation = await tx.insert('stock_reservations', {
        variant_id: variantId,
        location_id: locationId,
        qty: quantity,
        quantity,
        status: RESERVATION_STATUSES.ACTIVE,
        order_id: orderId,
        operation_id: operationId,
        actor_id: actorId,
        expires_at: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
        metadata
      });

      // Update cached level
      await tx.update('stock_levels', level.id, {
        reserved: newReserved,
        available: newAvailable
      });

      const response = {
        id: reservation.id,
        reservationId: reservation.id,
        variantId,
        locationId,
        qty: quantity,
        quantity,
        status: RESERVATION_STATUSES.ACTIVE,
        onHand: level.on_hand,
        reserved: newReserved,
        available: newAvailable
      };

      if (operationId) {
        await tx.insert('idempotency_keys', {
          key: operationId,
          resource_id: reservation.id,
          response_data: response,
          status_code: 200
        });
      }

      return response;
    });
  });
}

/**
 * 5. Release Reservation (Idempotent: INV-03-07)
 */
async function releaseReservation(tx, reservationIdOrParams) {
  const reservationId = typeof reservationIdOrParams === 'object' ? reservationIdOrParams.reservationId : reservationIdOrParams;
  const operationId = typeof reservationIdOrParams === 'object' ? reservationIdOrParams.operationId : null;
  const actorId = typeof reservationIdOrParams === 'object' ? reservationIdOrParams.actorId : null;

  // Idempotency check via operationId
  if (operationId) {
    const existingKey = await tx.query('idempotency_keys', k => k.key === operationId);
    if (existingKey.length > 0 && existingKey[0].response_data) {
      return existingKey[0].response_data;
    }
  }

  // Tenant boundary check
  const reservation = await validateTenantEntities(tx, { reservationId });

  // INV-03-07: Idempotent release
  if (reservation.status === RESERVATION_STATUSES.RELEASED || reservation.status === RESERVATION_STATUSES.CANCELLED) {
    const level = await getOrCreateStockLevel(tx, reservation.variant_id, reservation.location_id);
    const idempotentResponse = {
      cancelled: true,
      released: true,
      reservationId: reservation.id,
      status: reservation.status,
      reserved: level.reserved,
      available: level.available,
      idempotent: true
    };
    return idempotentResponse;
  }

  if (reservation.status === RESERVATION_STATUSES.CONSUMED) {
    throw new Error('Reservation Conflict: Cannot release an already consumed reservation');
  }

  const tenantId = tx.session.tenantId;
  const lockKey = `${tenantId}:${reservation.variant_id}:${reservation.location_id}`;

  return await withInventoryLocks([lockKey], async () => {
    return await runWithInventoryAuthority(tx, async () => {
      // Re-read under lock
      const currentRes = await tx.findById('stock_reservations', reservation.id);
      if (currentRes.status === RESERVATION_STATUSES.RELEASED || currentRes.status === RESERVATION_STATUSES.CANCELLED) {
        const level = await getOrCreateStockLevel(tx, currentRes.variant_id, currentRes.location_id);
        return {
          cancelled: true,
          released: true,
          reservationId: currentRes.id,
          status: currentRes.status,
          reserved: level.reserved,
          available: level.available,
          idempotent: true
        };
      }

      const level = await getOrCreateStockLevel(tx, currentRes.variant_id, currentRes.location_id);
      const newReserved = Math.max(0, level.reserved - currentRes.qty);
      const newAvailable = level.on_hand - newReserved;

      await tx.update('stock_reservations', currentRes.id, {
        status: RESERVATION_STATUSES.RELEASED
      });

      await tx.update('stock_levels', level.id, {
        reserved: newReserved,
        available: newAvailable
      });

      const response = {
        cancelled: true,
        released: true,
        reservationId: currentRes.id,
        status: RESERVATION_STATUSES.RELEASED,
        reserved: newReserved,
        available: newAvailable
      };

      if (operationId) {
        await tx.insert('idempotency_keys', {
          key: operationId,
          resource_id: currentRes.id,
          response_data: response,
          status_code: 200
        });
      }

      return response;
    });
  });
}

/**
 * 6. Consume Reservation (Idempotent: INV-03-08)
 */
async function consumeReservation(tx, reservationIdOrParams) {
  const reservationId = typeof reservationIdOrParams === 'object' ? reservationIdOrParams.reservationId : reservationIdOrParams;
  const operationId = typeof reservationIdOrParams === 'object' ? reservationIdOrParams.operationId : null;
  const actorId = typeof reservationIdOrParams === 'object' ? reservationIdOrParams.actorId : null;

  if (operationId) {
    const existingKey = await tx.query('idempotency_keys', k => k.key === operationId);
    if (existingKey.length > 0 && existingKey[0].response_data) {
      return existingKey[0].response_data;
    }
  }

  const reservation = await validateTenantEntities(tx, { reservationId });

  // INV-03-08: Idempotent consumption
  if (reservation.status === RESERVATION_STATUSES.CONSUMED) {
    const level = await getOrCreateStockLevel(tx, reservation.variant_id, reservation.location_id);
    return {
      fulfilled: true,
      consumed: true,
      reservationId: reservation.id,
      status: RESERVATION_STATUSES.CONSUMED,
      onHand: level.on_hand,
      reserved: level.reserved,
      available: level.available,
      idempotent: true
    };
  }

  if (reservation.status === RESERVATION_STATUSES.RELEASED || reservation.status === RESERVATION_STATUSES.CANCELLED) {
    throw new Error('Reservation Conflict: Cannot consume a released or cancelled reservation');
  }

  const tenantId = tx.session.tenantId;
  const lockKey = `${tenantId}:${reservation.variant_id}:${reservation.location_id}`;

  return await withInventoryLocks([lockKey], async () => {
    return await runWithInventoryAuthority(tx, async () => {
      const currentRes = await tx.findById('stock_reservations', reservation.id);
      if (currentRes.status === RESERVATION_STATUSES.CONSUMED) {
        const level = await getOrCreateStockLevel(tx, currentRes.variant_id, currentRes.location_id);
        return {
          fulfilled: true,
          consumed: true,
          reservationId: currentRes.id,
          status: RESERVATION_STATUSES.CONSUMED,
          onHand: level.on_hand,
          reserved: level.reserved,
          available: level.available,
          idempotent: true
        };
      }

      const level = await getOrCreateStockLevel(tx, currentRes.variant_id, currentRes.location_id);
      const newOnHand = level.on_hand - currentRes.qty;
      const newReserved = Math.max(0, level.reserved - currentRes.qty);
      const newAvailable = newOnHand - newReserved;

      if (newOnHand < 0) {
        throw new Error(`Invariant Violation INV-03-01: Insufficient on_hand (${level.on_hand}) to consume reservation of ${currentRes.qty}`);
      }

      // Mark reservation consumed
      await tx.update('stock_reservations', currentRes.id, {
        status: RESERVATION_STATUSES.CONSUMED
      });

      // Update levels
      await tx.update('stock_levels', level.id, {
        on_hand: newOnHand,
        reserved: newReserved,
        available: newAvailable
      });

      // Insert ledger movement for consumption (outbound sale/shipment)
      const movement = await tx.insert('stock_movements', {
        variant_id: currentRes.variant_id,
        location_id: currentRes.location_id,
        type: MOVEMENT_TYPES.SALE,
        qty: -currentRes.qty,
        quantity: -currentRes.qty,
        cost_price_centimes: 0n,
        reason: MOVEMENT_REASONS.ONLINE_SHIPMENT,
        reference_type: 'ONLINE_ORDER',
        reference_id: currentRes.order_id,
        operation_id: operationId,
        actor_id: actorId,
        metadata: {
          reservationId: currentRes.id,
          orderId: currentRes.order_id,
          consumedQuantity: currentRes.qty,
          onHand: newOnHand,
          reserved: newReserved,
          available: newAvailable
        }
      });

      const response = {
        fulfilled: true,
        consumed: true,
        movementId: movement.id,
        reservationId: currentRes.id,
        status: RESERVATION_STATUSES.CONSUMED,
        onHand: newOnHand,
        reserved: newReserved,
        available: newAvailable
      };

      if (operationId) {
        await tx.insert('idempotency_keys', {
          key: operationId,
          resource_id: currentRes.id,
          response_data: response,
          status_code: 200
        });
      }

      return response;
    });
  });
}

/**
 * 7. Inter-Location Transfer (Lifecycle: DRAFT -> PENDING -> COMPLETED / CANCELLED)
 */
async function createTransfer(tx, {
  variantId,
  fromLocationId,
  toLocationId,
  quantity,
  qty = quantity,
  notes = '',
  actorId = null
}) {
  const xferQty = quantity !== undefined ? quantity : qty;
  if (!Number.isInteger(xferQty) || xferQty <= 0) {
    throw new Error('Validation Error: Transfer quantity must be a strictly positive integer');
  }
  if (fromLocationId === toLocationId) {
    throw new Error('Validation Error: Source and destination locations cannot be identical');
  }

  await validateTenantEntities(tx, { variantId, locationId: fromLocationId });
  await validateTenantEntities(tx, { locationId: toLocationId });

  return await runWithInventoryAuthority(tx, async () => {
    return await tx.insert('stock_transfers', {
      variant_id: variantId,
      from_location_id: fromLocationId,
      to_location_id: toLocationId,
      quantity: xferQty,
      status: TRANSFER_STATUSES.PENDING,
      notes,
      actor_id: actorId
    });
  });
}

async function completeTransfer(tx, {
  transferId,
  operationId = null,
  actorId = null,
  metadata = {}
}) {
  return await runWithInventoryAuthority(tx, async () => {
    const transfer = await tx.findById('stock_transfers', transferId);
    if (!transfer) {
      throw new Error(`Transfer ${transferId} not found`);
    }
    if (transfer.status !== TRANSFER_STATUSES.PENDING) {
      throw new Error(`Cannot complete transfer in state '${transfer.status}'. Expected 'PENDING'.`);
    }

    const { variant_id: variantId, from_location_id: fromLocationId, to_location_id: toLocationId, quantity } = transfer;

    const tenantId = tx.session.tenantId;
    const lockKeys = [
      `${tenantId}:${variantId}:${fromLocationId}`,
      `${tenantId}:${variantId}:${toLocationId}`
    ];

    return await withInventoryLocks(lockKeys, async () => {
      // 1. Deduct from source
      await executeStockMutation(tx, {
        variantId,
        locationId: fromLocationId,
        quantityDelta: -quantity,
        movementType: MOVEMENT_TYPES.TRANSFER_OUT,
        referenceType: 'STOCK_TRANSFER',
        referenceId: transfer.id,
        operationId: operationId ? `${operationId}-OUT` : null,
        actorId,
        reason: MOVEMENT_REASONS.TRANSFER_OUT,
        metadata
      });

      // 2. Add to destination
      await executeStockMutation(tx, {
        variantId,
        locationId: toLocationId,
        quantityDelta: quantity,
        movementType: MOVEMENT_TYPES.TRANSFER_IN,
        referenceType: 'STOCK_TRANSFER',
        referenceId: transfer.id,
        operationId: operationId ? `${operationId}-IN` : null,
        actorId,
        reason: MOVEMENT_REASONS.TRANSFER_IN,
        metadata
      });

      // 3. Mark transfer completed
      await tx.update('stock_transfers', transfer.id, {
        status: TRANSFER_STATUSES.COMPLETED,
        completed_at: new Date().toISOString()
      });

      return {
        success: true,
        transferId: transfer.id,
        status: TRANSFER_STATUSES.COMPLETED,
        quantity
      };
    });
  });
}

async function cancelTransfer(tx, { transferId, actorId = null }) {
  return await runWithInventoryAuthority(tx, async () => {
    const transfer = await tx.findById('stock_transfers', transferId);
    if (!transfer) {
      throw new Error(`Transfer ${transferId} not found`);
    }
    if (transfer.status !== TRANSFER_STATUSES.PENDING && transfer.status !== TRANSFER_STATUSES.DRAFT) {
      throw new Error(`Cannot cancel transfer in state '${transfer.status}'. Only PENDING or DRAFT transfers can be cancelled.`);
    }

    await tx.update('stock_transfers', transfer.id, {
      status: TRANSFER_STATUSES.CANCELLED,
      cancelled_at: new Date().toISOString(),
      cancelled_by: actorId
    });

    return {
      success: true,
      transferId: transfer.id,
      status: TRANSFER_STATUSES.CANCELLED
    };
  });
}

/**
 * Atomic Location Transfer Helper (Direct / Backwards Compatible)
 */
async function transferStock(tx, params) {
  const variantId = params.variantId;
  const fromLocationId = params.fromLocationId;
  const toLocationId = params.toLocationId;
  const transferQuantity = params.quantity !== undefined ? params.quantity : params.qty;
  const reason = params.reason || 'LOCATION_TRANSFER';
  const operationId = params.operationId || null;
  const actorId = params.actorId || null;
  const metadata = params.metadata || {};

  if (!Number.isInteger(transferQuantity) || transferQuantity <= 0) {
    throw new Error('Validation Error: Transfer quantity must be a strictly positive integer');
  }
  if (fromLocationId === toLocationId) {
    throw new Error('Validation Error: Source and destination locations cannot be identical');
  }

  await validateTenantEntities(tx, { variantId, locationId: fromLocationId });
  await validateTenantEntities(tx, { locationId: toLocationId });

  const transfer = await createTransfer(tx, {
    variantId,
    fromLocationId,
    toLocationId,
    quantity: transferQuantity,
    notes: reason,
    actorId
  });

  const completion = await completeTransfer(tx, {
    transferId: transfer.id,
    operationId,
    actorId,
    metadata
  });

  return {
    success: true,
    transferId: transfer.id,
    ...completion
  };
}

/**
 * 8. Backwards Compatible applyStockMovement (INV-1, INV-7)
 */
async function applyStockMovement(tx, params) {
  const variantId = params.variantId;
  const locationId = params.locationId;
  const quantity = params.quantity !== undefined ? params.quantity : params.qty;
  const costPriceCentimes = params.costPriceCentimes || 0n;
  const reason = params.reason;
  const referenceType = params.referenceType || null;
  const referenceId = params.referenceId || null;
  const operationId = params.operationId || null;
  const actorId = params.actorId || null;
  const metadata = params.metadata || {};
  const allowNegative = Boolean(params.allowNegative);

  if (!variantId || !locationId || quantity === 0 || !reason) {
    throw new Error('Invalid stock movement parameters: variantId, locationId, non-zero qty and reason required');
  }

  let movementType = quantity > 0 ? MOVEMENT_TYPES.RECEIPT : MOVEMENT_TYPES.SALE;
  if (reason === MOVEMENT_REASONS.RETURN_RESTOCK) movementType = MOVEMENT_TYPES.RETURN;
  if (reason === MOVEMENT_REASONS.TRANSFER_OUT) movementType = MOVEMENT_TYPES.TRANSFER_OUT;
  if (reason === MOVEMENT_REASONS.TRANSFER_IN) movementType = MOVEMENT_TYPES.TRANSFER_IN;
  if (reason === MOVEMENT_REASONS.ADJUSTMENT || reason === MOVEMENT_REASONS.STOCKTAKE_ADJUSTMENT) {
    movementType = quantity > 0 ? MOVEMENT_TYPES.ADJUSTMENT_IN : MOVEMENT_TYPES.ADJUSTMENT_OUT;
  }

  return await executeStockMutation(tx, {
    variantId,
    locationId,
    quantityDelta: quantity,
    movementType,
    costPriceCentimes,
    referenceType,
    referenceId,
    operationId,
    actorId,
    reason,
    metadata,
    allowNegative
  });
}

/**
 * 9. Supplier Receiving with Weighted Average Cost (WAC / PMP) Recalculation (UAT-2)
 */
async function receiveSupplierGoods(tx, { variantId, locationId, qty, quantity = qty, unitCostCentimes, purchaseOrderId = null, actorId = null }) {
  const receivedQuantity = quantity !== undefined ? quantity : qty;
  if (receivedQuantity <= 0) throw new Error('Received quantity must be positive');
  const unitCost = BigInt(unitCostCentimes);

  const variant = await tx.findById('product_variants', variantId);
  if (!variant) throw new Error(`Variant ${variantId} not found`);

  const currentLevel = await getOrCreateStockLevel(tx, variantId, locationId);
  const currentQty = BigInt(Math.max(0, currentLevel.on_hand));
  const currentCost = BigInt(variant.cost_price || 0);
  const receivedQty = BigInt(receivedQuantity);

  let newWac = unitCost;
  const totalQty = currentQty + receivedQty;
  if (totalQty > 0n) {
    const totalValue = (currentQty * currentCost) + (receivedQty * unitCost);
    newWac = totalValue / totalQty;
  }

  // Update variant cost price to new WAC
  await tx.update('product_variants', variant.id, {
    cost_price: newWac
  });

  // Apply receiving movement
  await receiveStock(tx, {
    variantId,
    locationId,
    quantity: receivedQuantity,
    unitCostCentimes: newWac,
    referenceType: 'PURCHASE_ORDER',
    referenceId: purchaseOrderId,
    actorId
  });

  return {
    variantId,
    newOnHand: currentLevel.on_hand + receivedQuantity,
    oldWac: currentCost,
    newWac
  };
}

/**
 * 10. Physical Stocktake Reconciliation (UAT-9)
 */
async function reconcileStocktake(tx, { locationId, counts, notes = 'Physical Stocktake', actorId = null }) {
  return await runWithInventoryAuthority(tx, async () => {
    const session = await tx.insert('stocktake_sessions', {
      location_id: locationId,
      status: 'IN_PROGRESS',
      notes,
      actor_id: actorId
    });

    let adjustedCount = 0;

    for (const item of counts) {
      const level = await getOrCreateStockLevel(tx, item.variantId, locationId);
      const snapshotQty = level.on_hand;
      const countedQty = item.countedQty;
      const variance = countedQty - snapshotQty;

      await tx.insert('stocktake_items', {
        session_id: session.id,
        variant_id: item.variantId,
        snapshot_qty: snapshotQty,
        counted_qty: countedQty,
        variance_qty: variance
      });

      if (variance !== 0) {
        const reason = variance > 0 ? ADJUSTMENT_REASONS.FOUND : ADJUSTMENT_REASONS.COUNT_CORRECTION;
        await adjustStock(tx, {
          variantId: item.variantId,
          locationId,
          adjustment: variance,
          reason,
          referenceType: 'STOCKTAKE',
          referenceId: session.id,
          actorId
        });
        adjustedCount++;
      }
    }

    // Approve session
    await tx.update('stocktake_sessions', session.id, {
      status: 'APPROVED',
      approved_at: new Date().toISOString()
    });

    return {
      sessionId: session.id,
      status: 'APPROVED',
      totalCounted: counts.length,
      adjustedCount
    };
  });
}

/**
 * 11. Read Stock Level & Stock Ledger
 */
async function getVariantStock(tx, variantId, locationId) {
  await validateTenantEntities(tx, { variantId, locationId });
  const level = await getOrCreateStockLevel(tx, variantId, locationId);
  return {
    variantId,
    locationId,
    onHand: level.on_hand,
    reserved: level.reserved,
    available: level.available
  };
}

async function getStockLedger(tx, { variantId = null, locationId = null, limit = 100 } = {}) {
  return await tx.query('stock_movements', m => {
    if (variantId && m.variant_id !== variantId) return false;
    if (locationId && m.location_id !== locationId) return false;
    return true;
  });
}

module.exports = {
  MOVEMENT_TYPES,
  MOVEMENT_REASONS,
  RESERVATION_STATUSES,
  ADJUSTMENT_REASONS,
  TRANSFER_STATUSES,
  getOrCreateStockLevel,
  executeStockMutation,
  receiveStock,
  issueStock,
  adjustStock,
  reserveStock,
  releaseReservation,
  consumeReservation,
  createTransfer,
  completeTransfer,
  cancelTransfer,
  transferStock,
  applyStockMovement,
  createReservation: reserveStock,
  fulfillReservation: consumeReservation,
  cancelReservation: releaseReservation,
  receiveSupplierGoods,
  reconcileStocktake,
  getVariantStock,
  getStockLedger,
  runWithInventoryAuthority,
  withInventoryLocks
};
