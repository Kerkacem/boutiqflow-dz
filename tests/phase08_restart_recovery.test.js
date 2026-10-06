const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const {
  LocalOutbox,
  SyncEngine,
  DeviceService,
  OFFLINE_OPERATIONS,
  OUTBOX_STATUSES
} = require('../src/offline');

test('Phase 08 — Crash Survival & Restart Recovery Suite (INV-08-05, INV-08-06)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const deviceId = `POS-CRASH-${generateUUIDv7()}`;
  const outboxFilePath = path.join('/tmp', `outbox_${deviceId}.json`);

  let locationId = null;
  let cashierId = null;
  let variantId = null;
  let sessionId = null;

  await t.test('Setup server state: tenant, register, cashier, and variant with 20 units stock', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Didouche', type: 'shop' });
      locationId = loc.id;

      const user = await tx.insert('users', {
        name: 'Karim Cashier',
        email: 'karim@boutiqflow.dz',
        role: 'cashier',
        password_hash: 'hash'
      });
      cashierId = user.id;

      const reg = await tx.insert('cash_registers', { name: 'Caisse 1', location_id: locationId });
      const sess = await tx.insert('register_sessions', {
        register_id: reg.id,
        cashier_id: cashierId,
        opening_float_centimes: 1000000n, // 10,000 DA
        status: 'OPEN'
      });
      sessionId = sess.id;

      await DeviceService.registerDevice(tx, {
        registerId: reg.id,
        name: 'Compaq POS Terminal',
        deviceId
      });

      const prod = await tx.insert('products', { name: 'Gandoura Homme' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'GAN-HOM-BLANC-L',
        size: 'L',
        color: 'Blanc',
        cost_price: 300000n, // 3,000 DA
        sale_price: 550000n  // 5,500 DA
      });
      variantId = variant.id;

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: locationId,
        quantity: 20,
        movementType: 'IN',
        costPriceCentimes: 300000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });
  });

  await t.test('Offline: Enqueue 3 sales, force kill process/instance, restore from disk (INV-08-05)', async () => {
    // 1. Initial Outbox Instance
    const initialOutbox = new LocalOutbox({
      deviceId,
      tenantId,
      persistencePath: outboxFilePath
    });

    // Enqueue Sale 1 (1 unit)
    const op1 = initialOutbox.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.POS_SALE,
      payload: {
        sessionId,
        locationId,
        cashierId,
        items: [{ variantId, quantity: 1, unitPriceCentimes: 550000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 550000n }]
      }
    });

    // Enqueue Sale 2 (2 units)
    const op2 = initialOutbox.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.POS_SALE,
      payload: {
        sessionId,
        locationId,
        cashierId,
        items: [{ variantId, quantity: 2, unitPriceCentimes: 550000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 1100000n }]
      }
    });

    // Enqueue Sale 3 (1 unit)
    const op3 = initialOutbox.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.POS_SALE,
      payload: {
        sessionId,
        locationId,
        cashierId,
        items: [{ variantId, quantity: 1, unitPriceCentimes: 550000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 550000n }]
      }
    });

    assert.strictEqual(initialOutbox.getPendingCount(), 3);
    assert.strictEqual(initialOutbox.sequenceNumber, 3);

    // 2. SIMULATE BROWSER/PROCESS HARD CRASH
    // We discard the in-memory initialOutbox completely
    const crashedOutbox = null;

    // 3. REBOOT / REOPEN BROWSER
    // New fresh instance initialized from disk
    const restoredOutbox = new LocalOutbox({
      deviceId,
      tenantId,
      persistencePath: outboxFilePath
    });

    assert.strictEqual(restoredOutbox.getPendingCount(), 3, 'All 3 operations survived restart intact (INV-08-05)');
    assert.strictEqual(restoredOutbox.sequenceNumber, 3, 'Sequence number restored');

    const items = restoredOutbox.getItems();
    assert.strictEqual(items[0].operationId, op1.operationId);
    assert.strictEqual(items[0].sequenceNumber, 1);
    assert.strictEqual(items[1].operationId, op2.operationId);
    assert.strictEqual(items[1].sequenceNumber, 2);
    assert.strictEqual(items[2].operationId, op3.operationId);
    assert.strictEqual(items[2].sequenceNumber, 3);

    // 4. RECONNECT & SYNCHRONIZE WITH SERVER
    await db.withTenant({ tenantId }, async (tx) => {
      const syncRes = await SyncEngine.syncBatch(tx, {
        deviceId,
        operations: items
      });

      assert.strictEqual(syncRes.success, true);
      assert.strictEqual(syncRes.acknowledgements.length, 3);
      for (const ack of syncRes.acknowledgements) {
        assert.strictEqual(ack.status, OUTBOX_STATUSES.ACKED);
        restoredOutbox.ackOperation(ack.operationId, ack);
      }

      // Verify server inventory consumed: 4 units sold (1 + 2 + 1), 16 remaining
      const level = await tx.query('stock_levels', sl => sl.variant_id === variantId && sl.location_id === locationId);
      assert.strictEqual(level[0].on_hand, 16, 'Server stock decremented accurately by 4 units');

      // Verify 3 distinct sales created on server
      const sales = await tx.query('sales', s => s.tenant_id === tenantId);
      assert.strictEqual(sales.length, 3, 'Exactly 3 sales committed on server');
    });

    assert.strictEqual(restoredOutbox.getPendingCount(), 0, 'Outbox queue fully cleared/acknowledged');

    // Clean up tmp file
    restoredOutbox.clear();
  });
});
