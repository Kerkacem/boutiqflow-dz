/**
 * BoutiqFlow DZ — Authoritative Offline Sync Engine (INV-08-04, INV-08-12, INV-08-21)
 * Processes batched offline operations idempotently, validates device status,
 * guards against payload tampering, detects stock conflicts, and returns durable ACKs.
 */

const { generateUUIDv7 } = require('../db/utils');
const { getVariantStock } = require('../inventory/ledger');
const { processSale } = require('../pos/register');
const { DeviceService } = require('./device_service');
const { computeRequestHash } = require('./operation_identity');
const { StockAllowanceService } = require('./stock_allowance');
const {
  CAPABILITY_MATRIX,
  OFFLINE_OPERATIONS,
  OUTBOX_STATUSES,
  CONFLICT_TYPES
} = require('./constants');

class SyncEngine {
  /**
   * Synchronizes a batch of operations sent by a POS device
   * Returns authoritative server acknowledgements for each operation.
   */
  static async syncBatch(tx, {
    deviceId,
    operations = [],
    cursor = null
  }) {
    const tenantId = tx.session.tenantId;

    if (!deviceId) {
      throw new Error('Sync Error: deviceId is required');
    }

    // 1. Verify Device Authority & Revocation Status (INV-08-17, INV-08-23)
    let device;
    try {
      device = await DeviceService.verifyDevice(tx, { deviceId });
    } catch (err) {
      if (err.code === 'TENANT_MISMATCH') {
        throw err;
      }
      return {
        success: false,
        deviceId,
        deviceStatus: 'REVOKED',
        error: err.message,
        acknowledgements: operations.map(op => ({
          operationId: op.operationId,
          status: OUTBOX_STATUSES.CONFLICT,
          error: err.message,
          conflictCode: CONFLICT_TYPES.DEVICE_REVOKED
        }))
      };
    }

    const acknowledgements = [];

    // Process each operation in order
    for (const op of operations) {
      const {
        operationId,
        operationType,
        payload,
        clientTimestamp,
        sequenceNumber,
        dependsOnOperationId
      } = op;

      // Capability Matrix Enforcement (INV-08-11, INV-08-24)
      if (!CAPABILITY_MATRIX[operationType]) {
        acknowledgements.push({
          operationId,
          status: OUTBOX_STATUSES.PERMANENT_FAILURE,
          conflictCode: CONFLICT_TYPES.AUTHORITY_REVOKED,
          error: `Operation '${operationType}' is strictly prohibited offline (INV-08-11)`
        });
        continue;
      }

      const requestHash = computeRequestHash({ operationType, payload });

      // Check Dependency Ordering (INV-08-13)
      if (dependsOnOperationId) {
        const dep = await tx.query('processed_operations', p =>
          p.tenant_id === tenantId && p.operation_id === dependsOnOperationId
        );
        if (dep.length === 0) {
          acknowledgements.push({
            operationId,
            status: OUTBOX_STATUSES.CONFLICT,
            conflictCode: CONFLICT_TYPES.DEPENDENCY_MISSING,
            error: `Dependent operation '${dependsOnOperationId}' has not been committed`
          });
          continue;
        }
      }

      // Check Server Idempotency (INV-08-02, INV-08-21)
      const existingProcessed = await tx.query('processed_operations', p =>
        p.tenant_id === tenantId &&
        p.device_id === deviceId &&
        p.operation_id === operationId
      );

      if (existingProcessed.length > 0) {
        const prev = existingProcessed[0];

        // Check for Payload Hash Tampering (INV-08-03, Critical Test 40)
        if (prev.request_hash && prev.request_hash !== requestHash) {
          // Record security violation audit event
          await tx.insert('audit_logs', {
            action: 'IDEMPOTENCY_KEY_REUSE',
            actor_id: deviceId,
            entity_type: 'offline_operation',
            entity_id: operationId,
            details: {
              originalHash: prev.request_hash,
              tamperedHash: requestHash,
              operationType
            },
            created_at: new Date().toISOString()
          });

          acknowledgements.push({
            operationId,
            status: OUTBOX_STATUSES.CONFLICT,
            conflictCode: CONFLICT_TYPES.IDEMPOTENCY_KEY_REUSE,
            error: 'Security Violation: Operation ID reused with modified payload (INV-08-03)'
          });
          continue;
        }

        // Exact match: Replay original result with zero duplicate mutations (INV-08-12)
        acknowledgements.push({
          operationId,
          status: OUTBOX_STATUSES.ACKED,
          isDuplicate: true,
          replayed: true,
          serverReference: prev.server_reference,
          result: prev.result,
          acknowledgedAt: prev.processed_at
        });
        continue;
      }

      // Process Fresh Operation based on Type
      if (operationType === OFFLINE_OPERATIONS.POS_SALE) {
        // Normalize items: support both qty and quantity
        const normalizedItems = (payload.items || []).map(i => ({
          ...i,
          qty: i.qty !== undefined ? i.qty : i.quantity,
          quantity: i.quantity !== undefined ? i.quantity : i.qty
        }));

        // Authoritative Stock Verification (INV-08-16, Critical Test 42)
        let stockConflict = false;
        let conflictDetails = null;

        for (const item of normalizedItems) {
          const variantStock = await getVariantStock(tx, item.variantId, payload.locationId);
          if (variantStock.available < item.qty) {
            stockConflict = true;
            conflictDetails = {
              variantId: item.variantId,
              requested: item.qty,
              available: variantStock.available
            };
            break;
          }
        }

        if (stockConflict) {
          // Check if conflict already recorded for this operation (idempotent conflict recording)
          const existingConflict = await tx.query('sync_conflicts', c =>
            c.tenant_id === tenantId &&
            c.device_id === deviceId &&
            c.operation_id === operationId
          );

          if (existingConflict.length === 0) {
            // Record conflict in sync_conflicts (INV-08-16)
            await tx.insert('sync_conflicts', {
              id: generateUUIDv7(),
              tenant_id: tenantId,
              device_id: deviceId,
              operation_id: operationId,
              operation_type: operationType,
              conflict_type: CONFLICT_TYPES.STOCK_CONFLICT,
              details: conflictDetails,
              status: 'PENDING_REVIEW',
              created_at: new Date().toISOString()
            });
          }

          acknowledgements.push({
            operationId,
            status: OUTBOX_STATUSES.CONFLICT,
            conflictCode: CONFLICT_TYPES.STOCK_CONFLICT,
            details: conflictDetails,
            error: 'Stock conflict: Insufficient inventory on server to fulfill offline sale (INV-08-16)'
          });
          continue;
        }

        // Stock available: Execute POS Sale authoritatively
        const saleResult = await processSale(tx, {
          sessionId: payload.sessionId,
          registerId: payload.registerId || device.register_id,
          locationId: payload.locationId,
          cashierId: payload.cashierId,
          customerId: payload.customerId,
          items: normalizedItems,
          payments: payload.payments,
          discountCentimes: payload.discountCentimes || 0n,
          idempotencyKey: operationId,
          operationId: operationId,
          deviceId: deviceId,
          sequenceNumber: sequenceNumber || 1
        });

        // Settle allowance if granted
        for (const item of normalizedItems) {
          await StockAllowanceService.consumeAllowance(tx, {
            deviceId,
            variantId: item.variantId,
            locationId: payload.locationId,
            quantity: item.qty
          });
        }

        // Record in processed_operations (Durable Server Ack INV-08-21)
        const serverRef = saleResult.receiptNumber || saleResult.saleId;
        await tx.insert('processed_operations', {
          id: generateUUIDv7(),
          tenant_id: tenantId,
          device_id: deviceId,
          operation_id: operationId,
          operation_type: operationType,
          request_hash: requestHash,
          result: {
            saleId: saleResult.saleId,
            receiptNumber: saleResult.receiptNumber,
            totalCentimes: saleResult.total
          },
          status: 'ACKED',
          server_reference: serverRef,
          processed_at: new Date().toISOString()
        });

        acknowledgements.push({
          operationId,
          status: OUTBOX_STATUSES.ACKED,
          serverReference: serverRef,
          result: saleResult,
          acknowledgedAt: new Date().toISOString()
        });
      } else {
        // Other allowed operations (e.g. PAYMENT_RECORD, RECEIPT_GENERATION)
        const serverRef = `ack_${operationId}`;
        await tx.insert('processed_operations', {
          id: generateUUIDv7(),
          tenant_id: tenantId,
          device_id: deviceId,
          operation_id: operationId,
          operation_type: operationType,
          request_hash: requestHash,
          result: { success: true },
          status: 'ACKED',
          server_reference: serverRef,
          processed_at: new Date().toISOString()
        });

        acknowledgements.push({
          operationId,
          status: OUTBOX_STATUSES.ACKED,
          serverReference: serverRef,
          acknowledgedAt: new Date().toISOString()
        });
      }
    }

    const allAcked = acknowledgements.every(a => a.status === OUTBOX_STATUSES.ACKED);

    return {
      success: allAcked,
      deviceId,
      processedCount: operations.length,
      acknowledgements
    };
  }
}

module.exports = {
  SyncEngine
};
