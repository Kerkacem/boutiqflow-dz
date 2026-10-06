/**
 * BoutiqFlow DZ — Offline Stock Allowance & Bounded Budget Service (INV-08-25)
 * Grants server-authorized stock reservation budgets per POS device
 * to prevent unbounded offline overselling while maintaining high availability.
 */

const { generateUUIDv7 } = require('../db/utils');
const { getVariantStock } = require('../inventory/ledger');

class StockAllowanceService {
  /**
   * Authoritatively grants an offline stock allowance budget to a device
   */
  static async grantAllowance(tx, {
    deviceId,
    variantId,
    locationId,
    allowanceQty,
    grantedBy = 'system'
  }) {
    const tenantId = tx.session.tenantId;

    if (!Number.isInteger(allowanceQty) || allowanceQty <= 0) {
      throw new Error('Allowance quantity must be a strictly positive integer');
    }

    // Verify available server stock
    const stock = await getVariantStock(tx, variantId, locationId);
    if (stock.available < allowanceQty) {
      throw new Error(`Insufficient available stock (${stock.available}) to allocate allowance of ${allowanceQty} to device ${deviceId}`);
    }

    const existing = await tx.query('offline_stock_allowances', a =>
      a.tenant_id === tenantId &&
      a.device_id === deviceId &&
      a.variant_id === variantId &&
      a.location_id === locationId
    );

    if (existing.length > 0) {
      const record = existing[0];
      const newAllocated = record.allocated_allowance + allowanceQty;
      const newRemaining = record.remaining_allowance + allowanceQty;
      return await tx.update('offline_stock_allowances', record.id, {
        allocated_allowance: newAllocated,
        remaining_allowance: newRemaining,
        version: (record.version || 1) + 1,
        updated_at: new Date().toISOString()
      });
    }

    const allowanceId = generateUUIDv7();
    const record = {
      id: allowanceId,
      tenant_id: tenantId,
      device_id: deviceId,
      variant_id: variantId,
      location_id: locationId,
      allocated_allowance: allowanceQty,
      consumed_allowance: 0,
      remaining_allowance: allowanceQty,
      version: 1,
      granted_by: grantedBy,
      granted_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    return await tx.insert('offline_stock_allowances', record);
  }

  /**
   * Checks and consumes remaining allowance during sync or local simulation
   */
  static async consumeAllowance(tx, {
    deviceId,
    variantId,
    locationId,
    quantity
  }) {
    const tenantId = tx.session.tenantId;
    const allowances = await tx.query('offline_stock_allowances', a =>
      a.tenant_id === tenantId &&
      a.device_id === deviceId &&
      a.variant_id === variantId &&
      (!locationId || a.location_id === locationId)
    );

    if (allowances.length === 0) {
      return { allowed: false, reason: 'NO_ALLOWANCE_GRANTED' };
    }

    const record = allowances[0];
    if (record.remaining_allowance < quantity) {
      return {
        allowed: false,
        reason: 'INSUFFICIENT_ALLOWANCE',
        remaining: record.remaining_allowance,
        requested: quantity
      };
    }

    const updated = await tx.update('offline_stock_allowances', record.id, {
      consumed_allowance: record.consumed_allowance + quantity,
      remaining_allowance: record.remaining_allowance - quantity,
      version: (record.version || 1) + 1,
      updated_at: new Date().toISOString()
    });

    return {
      allowed: true,
      remaining: updated.remaining_allowance,
      consumed: updated.consumed_allowance
    };
  }

  /**
   * Retrieves remaining allowance for a device & variant
   */
  static async getRemainingAllowance(tx, { deviceId, variantId, locationId = null }) {
    const tenantId = tx.session.tenantId;
    const allowances = await tx.query('offline_stock_allowances', a =>
      a.tenant_id === tenantId &&
      a.device_id === deviceId &&
      a.variant_id === variantId &&
      (!locationId || a.location_id === locationId)
    );
    if (allowances.length === 0) return 0;
    return allowances[0].remaining_allowance;
  }
}

module.exports = {
  StockAllowanceService
};
