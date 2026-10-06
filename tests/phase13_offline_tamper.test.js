const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const {
  SyncEngine,
  DeviceService,
  OFFLINE_OPERATIONS,
  OUTBOX_STATUSES,
  CONFLICT_TYPES
} = require('../src/offline');
const { computeRequestHash } = require('../src/offline/operation_identity');

test('Phase 13 — Offline Queue Tampering & Revoked Device Red Team (INV-13-21, Requirements 71 & 72)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const deviceId = `DEV-${generateUUIDv7()}`;

  let locationId;
  let cashierId;
  let variantId;
  let sessionId;

  await t.test('Setup device, register and initial stock', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      await DeviceService.registerDevice(tx, {
        deviceId,
        tenantId,
        deviceName: 'POS Tablet 01',
        appVersion: '1.0.0'
      });

      const loc = await tx.insert('inventory_locations', { name: 'Shop Oran', type: 'shop' });
      locationId = loc.id;
      const user = await tx.insert('users', { name: 'Cashier', email: 'cashier@oran.dz', role: 'cashier' });
      cashierId = user.id;
      const reg = await tx.insert('cash_registers', { name: 'Reg 1', location_id: locationId });
      const sess = await tx.insert('register_sessions', {
        register_id: reg.id,
        cashier_id: cashierId,
        opening_float_centimes: 100000n,
        status: 'OPEN'
      });
      sessionId = sess.id;
      const cat = await tx.insert('categories', { name: 'Robes' });
      const prod = await tx.insert('products', { name: 'Robe Oranaise', category_id: cat.id });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'RO-01',
        sale_price: 500000n, // 5,000 DA
        cost_price: 200000n
      });
      variantId = v.id;

      // Seed 10 units in stock
      await applyStockMovement(tx, {
        variantId: v.id,
        locationId: loc.id,
        quantity: 10,
        movementType: 'IN',
        costPriceCentimes: 200000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });
  });

  await t.test('1. Tampered queue payload is rejected by server (INV-13-21, Requirement 72)', async () => {
    const operationId = 'OFFLINE-OP-TAMPER-001';
    const originalPayload = {
      sessionId,
      locationId,
      cashierId,
      items: [{ variantId, quantity: 1, unitPriceCentimes: 500000n }],
      payments: [{ tenderType: 'CASH', amountCentimes: 500000n }]
    };

    const authenticHash = computeRequestHash(originalPayload);

    // Attacker modifies unitPriceCentimes locally to 100 centimes (1 DA) instead of 5,000 DA
    const tamperedPayload = {
      ...originalPayload,
      items: [{ variantId, quantity: 1, unitPriceCentimes: 100n }],
      payments: [{ tenderType: 'CASH', amountCentimes: 100n }]
    };

    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Submit authentic operation
      const res1 = await SyncEngine.syncBatch(tx, {
        deviceId,
        operations: [{
          operationId,
          operationType: OFFLINE_OPERATIONS.POS_SALE,
          payload: originalPayload,
          requestHash: authenticHash,
          sequence: 1
        }]
      });
      assert.strictEqual(res1.success, true);

      // 2. Attacker replays with tampered payload
      const tamperedHash = computeRequestHash(tamperedPayload);
      const res2 = await SyncEngine.syncBatch(tx, {
        deviceId,
        operations: [{
          operationId,
          operationType: OFFLINE_OPERATIONS.POS_SALE,
          payload: tamperedPayload,
          requestHash: tamperedHash,
          sequence: 1
        }]
      });

      // Tampered replay must be rejected with CONFLICT
      assert.strictEqual(res2.acknowledgements[0].status, OUTBOX_STATUSES.CONFLICT);
      assert.ok(
        res2.acknowledgements[0].conflictCode === 'IDEMPOTENCY_KEY_REUSE' ||
        res2.acknowledgements[0].conflictCode === CONFLICT_TYPES.TAMPER_DETECTED
      );
    });
  });

  await t.test('2. Revoked Device sync attempts are strictly rejected (INV-13-21, Requirement 71)', async () => {
    const stolenOp = {
      operationId: 'OFFLINE-STOLEN-001',
      operationType: OFFLINE_OPERATIONS.POS_SALE,
      payload: {
        sessionId,
        locationId,
        cashierId,
        items: [{ variantId, quantity: 1, unitPriceCentimes: 500000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 500000n }]
      }
    };

    await db.withTenant({ tenantId }, async (tx) => {
      // Admin revokes device (e.g. tablet was reported stolen)
      await DeviceService.revokeDevice(tx, {
        deviceId,
        tenantId,
        reason: 'DEVICE_STOLEN_REPORTED'
      });

      // Attempt sync from stolen device
      const syncRes = await SyncEngine.syncBatch(tx, {
        deviceId,
        operations: [stolenOp]
      });

      assert.strictEqual(syncRes.success, false);
      assert.strictEqual(syncRes.deviceStatus, 'REVOKED');
      assert.strictEqual(syncRes.acknowledgements[0].status, OUTBOX_STATUSES.CONFLICT);
      assert.strictEqual(syncRes.acknowledgements[0].conflictCode, CONFLICT_TYPES.DEVICE_REVOKED);
    });
  });
});
