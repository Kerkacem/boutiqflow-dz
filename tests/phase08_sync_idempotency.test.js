const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const {
  LocalOutbox,
  SyncEngine,
  DeviceService,
  OFFLINE_OPERATIONS,
  OUTBOX_STATUSES,
  CONFLICT_TYPES
} = require('../src/offline');
const { computeRequestHash } = require('../src/offline/operation_identity');

test('Phase 08 — Sync Idempotency & Tamper Protection Suite (INV-08-02, INV-08-03, INV-08-12, CRITICAL TESTS 39 & 40)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const deviceId = `POS-IDEMP-${generateUUIDv7()}`;

  let locationId = null;
  let cashierId = null;
  let variantId = null;
  let sessionId = null;

  await t.test('Setup server state: tenant, register, cashier, and variant with 10 units stock', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Oran', type: 'shop' });
      locationId = loc.id;

      const user = await tx.insert('users', {
        name: 'Wahid Cashier',
        email: 'wahid@boutiqflow.dz',
        role: 'cashier',
        password_hash: 'hash'
      });
      cashierId = user.id;

      const reg = await tx.insert('cash_registers', { name: 'Caisse Oran 1', location_id: locationId });
      const sess = await tx.insert('register_sessions', {
        register_id: reg.id,
        cashier_id: cashierId,
        opening_float_centimes: 500000n, // 5,000 DA
        status: 'OPEN'
      });
      sessionId = sess.id;

      await DeviceService.registerDevice(tx, {
        registerId: reg.id,
        name: 'POS Terminal Oran',
        deviceId
      });

      const prod = await tx.insert('products', { name: 'Caftan Satin' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'CAF-SAT-VERT-M',
        size: 'M',
        color: 'Vert',
        cost_price: 200000n,
        sale_price: 300000n // 3,000 DA
      });
      variantId = variant.id;

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: locationId,
        quantity: 10,
        movementType: 'IN',
        costPriceCentimes: 200000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });
  });

  await t.test('CRITICAL TEST 39: Server commits sale -> response lost -> client retries 20 times (INV-08-02, INV-08-12)', async () => {
    const outbox = new LocalOutbox({ deviceId, tenantId });
    const op = outbox.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.POS_SALE,
      payload: {
        sessionId,
        locationId,
        cashierId,
        items: [{ variantId, quantity: 2, unitPriceCentimes: 300000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 600000n }]
      }
    });

    let firstAck = null;

    // Retry 20 times sequentially with the exact same operation
    for (let i = 0; i < 20; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const syncRes = await SyncEngine.syncBatch(tx, {
          deviceId,
          operations: [op]
        });

        assert.strictEqual(syncRes.success, true);
        assert.strictEqual(syncRes.acknowledgements.length, 1);
        const ack = syncRes.acknowledgements[0];
        assert.strictEqual(ack.status, OUTBOX_STATUSES.ACKED);

        if (i === 0) {
          firstAck = ack;
          assert.strictEqual(ack.isDuplicate, undefined);
        } else {
          // Replayed duplicate
          assert.strictEqual(ack.isDuplicate, true, `Retry #${i + 1} flagged as duplicate`);
          assert.strictEqual(ack.replayed, true);
          assert.strictEqual(ack.serverReference, firstAck.serverReference);
        }
      });
    }

    // Strict Invariant Checks (INV-08-02, INV-08-12):
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Exactly 1 sale in DB
      const sales = await tx.query('sales', s => s.tenant_id === tenantId);
      assert.strictEqual(sales.length, 1, 'Exactly 1 sale committed in database');

      // 2. Exactly 1 inventory deduction (10 - 2 = 8)
      const level = await tx.query('stock_levels', sl => sl.variant_id === variantId && sl.location_id === locationId);
      assert.strictEqual(level[0].on_hand, 8, 'Exactly 2 units consumed (on_hand = 8)');

      // 3. Exactly 1 cash movement recorded
      const cashTx = await tx.query('cash_transactions', ct => ct.session_id === sessionId && ct.type === 'SALE_CASH');
      assert.strictEqual(cashTx.length, 1, 'Exactly 1 cash transaction recorded');
      assert.strictEqual(cashTx[0].amount_centimes, 600000n);

      // 4. Exactly 1 processed_operations record
      const processed = await tx.query('processed_operations', p => p.tenant_id === tenantId);
      assert.strictEqual(processed.length, 1, 'Exactly 1 processed_operations record');
    });
  });

  await t.test('CRITICAL TEST 40: Modified Replay / Payload Tampering rejected (INV-08-03)', async () => {
    // 1. Initial valid request with operationId = X, amount = 3000 DA
    const operationId = `op_tamper_${generateUUIDv7()}`;
    const legitPayload = {
      sessionId,
      locationId,
      cashierId,
      items: [{ variantId, quantity: 1, unitPriceCentimes: 300000n }],
      payments: [{ tenderType: 'CASH', amountCentimes: 300000n }]
    };

    await db.withTenant({ tenantId }, async (tx) => {
      const res = await SyncEngine.syncBatch(tx, {
        deviceId,
        operations: [{
          operationId,
          operationType: OFFLINE_OPERATIONS.POS_SALE,
          payload: legitPayload,
          requestHash: computeRequestHash(legitPayload),
          sequenceNumber: 10
        }]
      });
      assert.strictEqual(res.acknowledgements[0].status, OUTBOX_STATUSES.ACKED);
    });

    // 2. Attacker replays same operationId but changes amount to 9000 DA (900,000 centimes)
    const tamperedPayload = {
      sessionId,
      locationId,
      cashierId,
      items: [{ variantId, quantity: 3, unitPriceCentimes: 300000n }],
      payments: [{ tenderType: 'CASH', amountCentimes: 900000n }]
    };

    await db.withTenant({ tenantId }, async (tx) => {
      const res = await SyncEngine.syncBatch(tx, {
        deviceId,
        operations: [{
          operationId,
          operationType: OFFLINE_OPERATIONS.POS_SALE,
          payload: tamperedPayload,
          requestHash: computeRequestHash(tamperedPayload), // Different hash!
          sequenceNumber: 11
        }]
      });

      assert.strictEqual(res.acknowledgements[0].status, OUTBOX_STATUSES.CONFLICT);
      assert.strictEqual(res.acknowledgements[0].conflictCode, CONFLICT_TYPES.IDEMPOTENCY_KEY_REUSE);
      assert.ok(res.acknowledgements[0].error.includes('Operation ID reused with modified payload'));

      // Verify security audit log was written
      const audit = await tx.query('audit_logs', a =>
        a.action === 'IDEMPOTENCY_KEY_REUSE' && a.entity_id === operationId
      );
      assert.strictEqual(audit.length, 1, 'Security audit logged for tampered replay');
    });

    // Verify ZERO additional financial mutations occurred
    await db.withTenant({ tenantId }, async (tx) => {
      // 2 sales total (1 from Test 39 + 1 from first legit request)
      const sales = await tx.query('sales', s => s.tenant_id === tenantId);
      assert.strictEqual(sales.length, 2, 'No third sale was created for tampered request');

      // Stock remaining is 7 (10 initial - 2 from Test 39 - 1 from legit request)
      const level = await tx.query('stock_levels', sl => sl.variant_id === variantId && sl.location_id === locationId);
      assert.strictEqual(level[0].on_hand, 7, 'Stock level protected from tampered deduction');
    });
  });

  await t.test('INV-08-13: Dependency Ordering: Missing dependent operation causes CONFLICT', async () => {
    const uncommittedParentOpId = `op_parent_${generateUUIDv7()}`;
    const dependentOp = {
      operationId: `op_child_${generateUUIDv7()}`,
      operationType: OFFLINE_OPERATIONS.PAYMENT_RECORD,
      payload: { amountCentimes: 100000n },
      dependsOnOperationId: uncommittedParentOpId
    };

    await db.withTenant({ tenantId }, async (tx) => {
      const res = await SyncEngine.syncBatch(tx, {
        deviceId,
        operations: [dependentOp]
      });

      assert.strictEqual(res.acknowledgements[0].status, OUTBOX_STATUSES.CONFLICT);
      assert.strictEqual(res.acknowledgements[0].conflictCode, CONFLICT_TYPES.DEPENDENCY_MISSING);
    });
  });
});
