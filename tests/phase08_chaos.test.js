const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { applyStockMovement, getVariantStock, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const { processSale } = require('../src/pos/register');
const {
  LocalOutbox,
  SyncEngine,
  DeviceService,
  OFFLINE_OPERATIONS,
  OUTBOX_STATUSES,
  CONFLICT_TYPES
} = require('../src/offline');

test('Phase 08 — The Final Chaos Test (Multi-stage Failure, Flapping Network, Out-of-order, Replay, Concurrent Mutation)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const deviceA = `POS-CHAOS-A-${generateUUIDv7()}`;
  const deviceB = `POS-CHAOS-B-${generateUUIDv7()}`;
  const persistencePathA = path.join(os.tmpdir(), `outbox_chaos_${deviceA}.json`);

  let locationId = null;
  let cashierAId = null;
  let cashierBId = null;
  let registerAId = null;
  let registerBId = null;
  let sessionAId = null;
  let sessionBId = null;
  let variantId = null;

  await t.test('Phase 08 Chaos Setup: 10 units in stock, 2 cash registers, 2 open sessions', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Alger Centre', type: 'shop' });
      locationId = loc.id;

      const userA = await tx.insert('users', {
        name: 'Amine Caisse A',
        email: 'amine@boutiqflow.dz',
        role: 'cashier',
        password_hash: 'hash'
      });
      cashierAId = userA.id;

      const userB = await tx.insert('users', {
        name: 'Karim Caisse B',
        email: 'karim@boutiqflow.dz',
        role: 'cashier',
        password_hash: 'hash'
      });
      cashierBId = userB.id;

      const regA = await tx.insert('cash_registers', { name: 'Caisse A', location_id: locationId });
      const regB = await tx.insert('cash_registers', { name: 'Caisse B', location_id: locationId });
      registerAId = regA.id;
      registerBId = regB.id;

      const sessA = await tx.insert('register_sessions', {
        register_id: regA.id,
        cashier_id: cashierAId,
        opening_float_centimes: 1000000n,
        status: 'OPEN'
      });
      sessionAId = sessA.id;

      const sessB = await tx.insert('register_sessions', {
        register_id: regB.id,
        cashier_id: cashierBId,
        opening_float_centimes: 1000000n,
        status: 'OPEN'
      });
      sessionBId = sessB.id;

      await DeviceService.registerDevice(tx, { registerId: regA.id, name: 'POS Terminal A', deviceId: deviceA });
      await DeviceService.registerDevice(tx, { registerId: regB.id, name: 'POS Terminal B', deviceId: deviceB });

      const prod = await tx.insert('products', { name: 'Abaya Moderne' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'ABA-MOD-VERT-L',
        size: 'L',
        color: 'Vert',
        cost_price: 250000n,
        sale_price: 500000n // 5,000 DA
      });
      variantId = variant.id;

      // Initial server stock = 10 units
      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId,
        quantity: 10,
        qty: 10,
        movementType: 'IN',
        costPriceCentimes: 250000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      const initialStock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(initialStock.onHand, 10);
      assert.strictEqual(initialStock.available, 10);
    });
  });

  await t.test('THE FINAL CHAOS SCENARIO EXECUTION', async () => {
    // 1. Device A offline: Sale 1 (qty 2) & Sale 2 (qty 1)
    let outboxA = new LocalOutbox({ deviceId: deviceA, tenantId, persistencePath: persistencePathA });
    const opSale1 = outboxA.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.POS_SALE,
      payload: {
        sessionId: sessionAId,
        registerId: registerAId,
        locationId,
        cashierId: cashierAId,
        items: [{ variantId, quantity: 2, unitPriceCentimes: 500000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 1000000n }]
      }
    });

    const opSale2 = outboxA.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.POS_SALE,
      payload: {
        sessionId: sessionAId,
        registerId: registerAId,
        locationId,
        cashierId: cashierAId,
        items: [{ variantId, quantity: 1, unitPriceCentimes: 500000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 500000n }]
      }
    });

    // 2. Browser crash & restart -> Reinstantiate outbox from durable store
    outboxA = new LocalOutbox({ deviceId: deviceA, tenantId, persistencePath: persistencePathA });
    const pendingAfterRestart = outboxA.getItems();
    assert.strictEqual(pendingAfterRestart.length, 2, 'Operations survived crash/restart (INV-08-05)');

    // 3. Sale 3 (qty 2) enqueued offline
    const opSale3 = outboxA.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.POS_SALE,
      payload: {
        sessionId: sessionAId,
        registerId: registerAId,
        locationId,
        cashierId: cashierAId,
        items: [{ variantId, quantity: 2, unitPriceCentimes: 500000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 1000000n }]
      }
    });
    assert.strictEqual(outboxA.getItems().length, 3);

    // 4. Connection flaps: Sync starts -> Server processes Sale 1, response is lost
    await db.withTenant({ tenantId }, async (tx) => {
      const res1 = await SyncEngine.syncBatch(tx, {
        deviceId: deviceA,
        operations: [opSale1]
      });
      assert.strictEqual(res1.success, true);
      assert.strictEqual(res1.acknowledgements[0].status, OUTBOX_STATUSES.ACKED);
    });

    // Client did not receive ack (simulated response lost) -> outbox still has opSale1 as QUEUED/SENDING

    // 5. Client retries Sale 1 x 10 times
    for (let r = 0; r < 10; r++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const retryRes = await SyncEngine.syncBatch(tx, {
          deviceId: deviceA,
          operations: [opSale1]
        });
        assert.strictEqual(retryRes.success, true);
        assert.strictEqual(retryRes.acknowledgements[0].status, OUTBOX_STATUSES.ACKED);
        assert.strictEqual(retryRes.acknowledgements[0].replayed, true, 'Server detects idempotent duplicate replay');
      });
    }
    outboxA.ackOperation(opSale1.operationId, { status: 'ACKED' });

    // 6. Sale 2 arrives and syncs
    await db.withTenant({ tenantId }, async (tx) => {
      const res2 = await SyncEngine.syncBatch(tx, {
        deviceId: deviceA,
        operations: [opSale2]
      });
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res2.acknowledgements[0].status, OUTBOX_STATUSES.ACKED);
    });
    outboxA.ackOperation(opSale2.operationId, { status: 'ACKED' });

    // Current stock after Sale 1 (2 units) + Sale 2 (1 unit) = 7 units remaining
    await db.withTenant({ tenantId }, async (tx) => {
      const stockMid = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stockMid.available, 7);
    });

    // 7. Device B concurrently sells 6 units online!
    await db.withTenant({ tenantId }, async (tx) => {
      const saleB = await processSale(tx, {
        sessionId: sessionBId,
        registerId: registerBId,
        locationId,
        cashierId: cashierBId,
        items: [{ variantId, qty: 6, unitPriceCentimes: 500000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 3000000n }],
        idempotencyKey: `SALE-DEVICE-B-ONLINE-${generateUUIDv7()}`,
        deviceId: deviceB
      });
      assert.ok(saleB.saleId);

      const stockAfterB = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stockAfterB.available, 1, 'Only 1 unit available now on server');
    });

    // 8. Device A sends Sale 3 (needs 2 units, but only 1 available)
    await db.withTenant({ tenantId }, async (tx) => {
      const res3 = await SyncEngine.syncBatch(tx, {
        deviceId: deviceA,
        operations: [opSale3]
      });
      assert.strictEqual(res3.success, false);
      const ack3 = res3.acknowledgements[0];
      assert.strictEqual(ack3.status, OUTBOX_STATUSES.CONFLICT);
      assert.strictEqual(ack3.conflictCode, CONFLICT_TYPES.STOCK_CONFLICT);
    });
    outboxA.failOperation(opSale3.operationId, {
      conflictCode: CONFLICT_TYPES.STOCK_CONFLICT,
      error: { message: 'Insufficient server stock' }
    });

    // 9. Network drops again, device reconnects, sync x 20
    for (let loop = 0; loop < 20; loop++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const fullBatchSync = await SyncEngine.syncBatch(tx, {
          deviceId: deviceA,
          operations: [opSale1, opSale2, opSale3]
        });

        // opSale1 -> ACKED (replayed)
        assert.strictEqual(fullBatchSync.acknowledgements[0].status, OUTBOX_STATUSES.ACKED);
        assert.strictEqual(fullBatchSync.acknowledgements[0].replayed, true);

        // opSale2 -> ACKED (replayed)
        assert.strictEqual(fullBatchSync.acknowledgements[1].status, OUTBOX_STATUSES.ACKED);
        assert.strictEqual(fullBatchSync.acknowledgements[1].replayed, true);

        // opSale3 -> CONFLICT (stock conflict preserved)
        assert.strictEqual(fullBatchSync.acknowledgements[2].status, OUTBOX_STATUSES.CONFLICT);
        assert.strictEqual(fullBatchSync.acknowledgements[2].conflictCode, CONFLICT_TYPES.STOCK_CONFLICT);
      });
    }

    // 10. STRICT CHAOS INVARIANT VERIFICATIONS:
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. NO DUPLICATE SALE: Exactly 3 sales committed in the database (Sale 1, Sale 2, Sale B)
      const sales = await tx.query('sales', s => s.tenant_id === tenantId);
      assert.strictEqual(sales.length, 3, 'Exactly 3 sales committed in database');

      // 2. NO DUPLICATE INVENTORY MOVEMENT: Exactly 3 sale movements (-2, -1, -6 = -9 units)
      const movements = await tx.query('stock_movements', sm => sm.reference_type === 'SALE_RECEIPT');
      assert.strictEqual(movements.length, 3, 'Exactly 3 inventory sale movements');
      const totalUnitsSold = movements.reduce((acc, m) => acc + Math.abs(m.qty), 0);
      assert.strictEqual(totalUnitsSold, 9, 'Exactly 9 units deducted in total');

      // 3. NO NEGATIVE STOCK (INV-08-16): Stock is exactly 1 unit
      const finalStock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(finalStock.onHand, 1);
      assert.strictEqual(finalStock.available, 1);
      assert.ok(finalStock.available >= 0, 'No negative stock permitted');

      // 4. NO DUPLICATE CASH MOVEMENT: Exactly 3 cash movements
      const cashMovements = await tx.query('cash_transactions', ct => ct.type === 'SALE_CASH');
      assert.strictEqual(cashMovements.length, 3, 'Exactly 3 sale cash transactions recorded');

      // 5. NO LOST QUEUED OPERATION: Outbox has all 3 operations with accurate terminal states
      const allOps = outboxA.getItems();
      assert.strictEqual(allOps.length, 3);
      assert.strictEqual(allOps[0].status, OUTBOX_STATUSES.ACKED);
      assert.strictEqual(allOps[1].status, OUTBOX_STATUSES.ACKED);
      assert.strictEqual(allOps[2].status, OUTBOX_STATUSES.CONFLICT);

      // 6. NO FAKE "SYNC SUCCESS": Sale 3 is recorded in sync_conflicts as PENDING_REVIEW
      const conflicts = await tx.query('sync_conflicts', c => c.tenant_id === tenantId);
      assert.strictEqual(conflicts.length, 1);
      assert.strictEqual(conflicts[0].conflict_type, CONFLICT_TYPES.STOCK_CONFLICT);
      assert.strictEqual(conflicts[0].status, 'PENDING_REVIEW');
    });

    outboxA.clear();
  });
});
