const { createReservation, releaseReservation, getOrCreateStockLevel, withInventoryLocks } = require('../inventory/ledger');

/**
 * COD Confirmation Domain Service for BoutiqFlow DZ
 * 
 * Invariants:
 * - INV-06-01: Creating an OnlineOrder never reserves inventory.
 * - INV-06-02: Only server-authorized CONFIRMED state may trigger reservation.
 * - INV-06-03: A reservation belongs to exactly one Order and Variant context.
 * - INV-06-04: Order confirmation is idempotent.
 * - INV-06-05: Reservation creation for an Order is idempotent.
 * - INV-06-06: Cancellation releases an existing reservation at most once.
 * - INV-06-07: Refused/Expired orders without reservation never mutate inventory.
 * - INV-06-12: Every COD attempt is append-only and auditable.
 * - INV-06-16: A failed confirmation->reservation transaction leaves no partial state.
 */

const CONFIRMATION_STATUSES = {
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION',
  CALLING: 'CALLING',
  CONFIRMED: 'CONFIRMED',
  UNREACHABLE: 'UNREACHABLE',
  REFUSED: 'REFUSED',
  INVALID_NUMBER: 'INVALID_NUMBER',
  CALL_BACK_LATER: 'CALL_BACK_LATER',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  STOCK_UNAVAILABLE: 'STOCK_UNAVAILABLE'
};

const CONFIRMATION_CHANNELS = {
  PHONE_CALL: 'PHONE_CALL',
  PHONE: 'PHONE_CALL',
  WHATSAPP_MESSAGE: 'WHATSAPP_MESSAGE',
  WHATSAPP: 'WHATSAPP_MESSAGE',
  MANUAL: 'MANUAL',
  SMS: 'SMS'
};

class CodConfirmationService {
  /**
   * Records a phone call or WhatsApp message attempt to confirm an online order.
   * Append-only event log (INV-06-12).
   */
  static async logCallAttempt(tx, {
    orderId,
    agentId = null,
    channel = CONFIRMATION_CHANNELS.PHONE_CALL,
    outcome,
    nextAttemptAt = null,
    notes = ''
  }) {
    const order = await tx.findById('online_orders', orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    const previousAttempts = await tx.query('order_call_attempts', a => a.order_id === orderId);
    const attemptNumber = previousAttempts.length + 1;

    // 1. Record immutable attempt in order_call_attempts (backwards compatibility)
    const attempt = await tx.insert('order_call_attempts', {
      order_id: orderId,
      attempt_number: attemptNumber,
      agent_id: agentId,
      channel,
      outcome,
      next_attempt_scheduled_at: nextAttemptAt,
      notes
    });

    // 2. Also record in confirmation_attempts table (INV-06-12)
    await tx.insert('confirmation_attempts', {
      order_id: orderId,
      attempt_number: attemptNumber,
      actor_id: agentId,
      channel,
      outcome,
      notes
    });

    // Determine new status
    let newStatus = order.status;
    let newConfStatus = CONFIRMATION_STATUSES.CALLING;

    if (outcome === 'ANSWERED_CONFIRMED' || outcome === 'CONFIRMED') {
      newConfStatus = CONFIRMATION_STATUSES.CONFIRMED;
      newStatus = 'CONFIRMED';
    } else if (outcome === 'NO_ANSWER' || outcome === 'BUSY' || outcome === 'UNREACHABLE') {
      newConfStatus = attemptNumber >= 3 ? CONFIRMATION_STATUSES.CANCELLED : CONFIRMATION_STATUSES.UNREACHABLE;
      newStatus = attemptNumber >= 3 ? 'CANCELLED' : order.status;
    } else if (outcome === 'REFUSED') {
      newConfStatus = CONFIRMATION_STATUSES.REFUSED;
      newStatus = 'CANCELLED';
    } else if (outcome === 'WRONG_NUMBER' || outcome === 'INVALID_NUMBER') {
      newConfStatus = CONFIRMATION_STATUSES.INVALID_NUMBER;
      newStatus = order.status;
    } else if (outcome === 'ASKED_DELAY' || outcome === 'CALL_BACK_LATER') {
      newConfStatus = CONFIRMATION_STATUSES.CALL_BACK_LATER;
      newStatus = order.status;
    }

    await tx.update('online_orders', orderId, {
      confirmation_status: newConfStatus,
      status: newStatus,
      call_attempts_count: attemptNumber,
      last_call_attempt_at: new Date().toISOString()
    });

    // Update or insert cod_confirmations record
    const confs = await tx.query('cod_confirmations', c => c.order_id === orderId);
    if (confs.length > 0) {
      await tx.update('cod_confirmations', confs[0].id, {
        status: newConfStatus,
        attempt_count: attemptNumber,
        last_attempt_at: new Date().toISOString(),
        next_attempt_at: nextAttemptAt,
        notes
      });
    }

    await tx.insert('audit_logs', {
      action: 'COD_CONFIRMATION_ATTEMPTED',
      actor_id: agentId,
      entity_type: 'online_orders',
      entity_id: orderId,
      details: {
        attemptNumber,
        channel,
        outcome,
        newStatus
      }
    });

    return attempt;
  }

  /**
   * Confirms order and triggers atomic inventory reservation (INV-06-02, INV-06-16).
   * Fully idempotent (INV-06-04, INV-06-05).
   */
  static async confirmAndReserve(tx, { orderId, locationId, agentId = null, notes = '', operationId = null }) {
    const tenantId = tx.session.tenantId;
    const lockKey = `order:confirm:${tenantId}:${orderId}`;

    return await withInventoryLocks([lockKey], async () => {
      const order = await tx.findById('online_orders', orderId);
      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }

      if (['CANCELLED', 'REFUSED', 'EXPIRED', 'DELIVERED', 'SHIPPED'].includes(order.status)) {
        throw new Error(`Cannot confirm an order that is in status '${order.status}'`);
      }

      const items = await tx.query('order_items', i => i.order_id === orderId);

      // INV-06-04 & INV-06-05: Idempotency check
      // If order is already confirmed/reserved and has existing reservations, return replayed: true
      const hasActiveReservations = items.some(i => i.reservation_id !== null && i.reservation_id !== undefined);
      if ((order.status === 'CONFIRMED' || order.status === 'RESERVED') && hasActiveReservations) {
        return {
          orderId,
          status: 'CONFIRMED',
          reservationsCount: items.filter(i => i.reservation_id).length,
          replayed: true
        };
      }

      const targetLocationId = locationId || tx.session.locationId;
      if (!targetLocationId) {
        throw new Error('Validation Error: locationId is required to reserve stock upon confirmation');
      }

      // Check stock availability across all items before reserving (INV-06-16)
      for (const item of items) {
        const level = await getOrCreateStockLevel(tx, item.variant_id, targetLocationId);
        if (level.available < item.qty) {
          // Stock unavailable - no partial reservations allowed
          await tx.update('online_orders', orderId, {
            status: CONFIRMATION_STATUSES.STOCK_UNAVAILABLE,
            confirmation_status: CONFIRMATION_STATUSES.STOCK_UNAVAILABLE
          });
          throw new Error(`Invariant Violation INV-06-16: Insufficient stock for variant ${item.variant_id}. Requested ${item.qty}, available ${level.available}. No partial reservation created.`);
        }
      }

      // Reserve stock atomically for each line item (INV-06-02, INV-06-03)
      const reservations = [];
      for (const item of items) {
        const reservation = await createReservation(tx, {
          variantId: item.variant_id,
          locationId: targetLocationId,
          qty: item.qty,
          orderId: order.id,
          referenceType: 'ONLINE_ORDER',
          referenceId: order.id,
          operationId: operationId ? `${operationId}:item:${item.id}` : null
        });
        await tx.update('order_items', item.id, { reservation_id: reservation.id });
        reservations.push(reservation);
      }

      await tx.update('online_orders', orderId, {
        confirmation_status: CONFIRMATION_STATUSES.CONFIRMED,
        status: 'CONFIRMED',
        confirmed_by: agentId,
        confirmed_at: new Date().toISOString(),
        confirmation_note: notes
      });

      const confs = await tx.query('cod_confirmations', c => c.order_id === orderId);
      if (confs.length > 0) {
        await tx.update('cod_confirmations', confs[0].id, {
          status: CONFIRMATION_STATUSES.CONFIRMED,
          confirmed_at: new Date().toISOString(),
          confirmed_by: agentId,
          notes
        });
      }

      await tx.insert('audit_logs', {
        action: 'COD_CONFIRMED',
        actor_id: agentId,
        entity_type: 'online_orders',
        entity_id: orderId,
        details: {
          locationId: targetLocationId,
          reservationsCount: reservations.length,
          operationId
        }
      });

      return {
        orderId,
        status: 'CONFIRMED',
        reservationsCount: reservations.length,
        replayed: false
      };
    });
  }

  /**
   * Cancels a confirmed order and releases held inventory reservations (INV-06-06).
   * Safe idempotent release: cancel x 10 releases reservation at most once!
   */
  static async cancelAndRelease(tx, { orderId, reason = 'Customer cancelled', actorId = null }) {
    const order = await tx.findById('online_orders', orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (order.status === 'CANCELLED') {
      return { orderId, status: 'CANCELLED', released: false, replayed: true };
    }

    const items = await tx.query('order_items', i => i.order_id === orderId);

    // Release all active reservations exactly once (INV-06-06)
    let releasedCount = 0;
    for (const item of items) {
      if (item.reservation_id) {
        await releaseReservation(tx, item.reservation_id);
        await tx.update('order_items', item.id, { reservation_id: null });
        releasedCount++;
      }
    }

    await tx.update('online_orders', orderId, {
      confirmation_status: CONFIRMATION_STATUSES.CANCELLED,
      status: 'CANCELLED',
      cancellation_reason: reason,
      cancelled_at: new Date().toISOString()
    });

    const confs = await tx.query('cod_confirmations', c => c.order_id === orderId);
    if (confs.length > 0) {
      await tx.update('cod_confirmations', confs[0].id, {
        status: CONFIRMATION_STATUSES.CANCELLED,
        notes: reason
      });
    }

    await tx.insert('audit_logs', {
      action: 'ORDER_CANCELLED',
      actor_id: actorId,
      entity_type: 'online_orders',
      entity_id: orderId,
      details: {
        reason,
        reservationsReleased: releasedCount
      }
    });

    return { orderId, status: 'CANCELLED', released: releasedCount > 0, replayed: false };
  }

  /**
   * Customer refused order (INV-06-07).
   * If stock was held, releases reservation; if unreserved, mutates zero stock.
   */
  static async refuseOrder(tx, { orderId, reason = 'Customer refused delivery', actorId = null }) {
    const order = await tx.findById('online_orders', orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);

    if (order.status === 'REFUSED') {
      return { orderId, status: 'REFUSED', replayed: true };
    }

    const items = await tx.query('order_items', i => i.order_id === orderId);

    // Release reservations if any exist (INV-06-07)
    let releasedCount = 0;
    for (const item of items) {
      if (item.reservation_id) {
        await releaseReservation(tx, item.reservation_id);
        await tx.update('order_items', item.id, { reservation_id: null });
        releasedCount++;
      }
    }

    await tx.update('online_orders', orderId, {
      confirmation_status: CONFIRMATION_STATUSES.REFUSED,
      status: 'REFUSED',
      refusal_reason: reason,
      refused_at: new Date().toISOString()
    });

    const confs = await tx.query('cod_confirmations', c => c.order_id === orderId);
    if (confs.length > 0) {
      await tx.update('cod_confirmations', confs[0].id, {
        status: CONFIRMATION_STATUSES.REFUSED,
        notes: reason
      });
    }

    await tx.insert('audit_logs', {
      action: 'COD_REFUSED',
      actor_id: actorId,
      entity_type: 'online_orders',
      entity_id: orderId,
      details: { reason, reservationsReleased: releasedCount }
    });

    return { orderId, status: 'REFUSED', released: releasedCount > 0, replayed: false };
  }

  /**
   * Expire an unconfirmed order (INV-06-07).
   * Unconfirmed orders never reserved stock, so expiration causes zero stock mutation!
   */
  static async expireOrder(tx, { orderId, timeoutMinutes = 2880, actorId = null }) {
    const order = await tx.findById('online_orders', orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);

    if (order.status === 'EXPIRED') {
      return { orderId, status: 'EXPIRED', replayed: true };
    }

    // Release reservations if any existed
    const items = await tx.query('order_items', i => i.order_id === orderId);
    for (const item of items) {
      if (item.reservation_id) {
        await releaseReservation(tx, item.reservation_id);
        await tx.update('order_items', item.id, { reservation_id: null });
      }
    }

    await tx.update('online_orders', orderId, {
      confirmation_status: CONFIRMATION_STATUSES.EXPIRED,
      status: 'EXPIRED',
      expired_at: new Date().toISOString()
    });

    const confs = await tx.query('cod_confirmations', c => c.order_id === orderId);
    if (confs.length > 0) {
      await tx.update('cod_confirmations', confs[0].id, {
        status: CONFIRMATION_STATUSES.EXPIRED,
        notes: `Expired after ${timeoutMinutes} minutes without confirmation`
      });
    }

    await tx.insert('audit_logs', {
      action: 'ORDER_EXPIRED',
      actor_id: actorId,
      entity_type: 'online_orders',
      entity_id: orderId,
      details: { timeoutMinutes }
    });

    return { orderId, status: 'EXPIRED', replayed: false };
  }
}

module.exports = {
  CodConfirmationService,
  CONFIRMATION_STATUSES,
  CONFIRMATION_CHANNELS
};
