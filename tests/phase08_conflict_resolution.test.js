const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const { ROLES } = require('../src/rbac/permissions');
const {
  LocalOutbox,
  SyncEngine,
  DeviceService,
  StockAllowanceService,
  ConflictService,
  OFFLINE_OPERATIONS,
  OUTBOX_STATUSES,
  CONFLICT_TYPES,
  CONFLICT_RESOLUTION_ACTIONS
} = require('../src/offline');

test('Phase 08 — Stock Conflict & Controlled Manager Resolution Suite (INV-08-10, INV-08-15, INV-08-16, CRITICAL TEST 42)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const deviceId = `POS-CONF-${generateUUIDv7()}`;

  let locationId = null;
  let cashierId = null;
  let managerId = null;
  let variantId = null;
  let sessionId = null;

  await t.test('Setup server state: initial stock = 5, grant device allowance = 3', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Dépôt Sétif', type: 'shop' });
      locationId = loc.id;

      const user1 = await tx.insert('users', {
        name: 'Ahmed Cashier',
        email: 'ahmed@boutiqflow.dz',
        role: 'cashier',
        password_hash: 'hash'
      });
      cashierId = user1.id;

      const user2 = await tx.insert('users', {
        name: 'Karima Manager',
        email: 'karima@boutiqflow.dz',
        role: 'manager',
        password_hash: 'hash'
      });
      managerId = user2.id;

      const reg = await tx.insert('cash_registers', { name: 'Caisse Sétif 1', location_id: locationId });
      const sess = await tx.insert('register_sessions', {
        register_id: reg.id,
        cashier_id: cashierId,
        opening_float_centimes: 500000n,
        status: 'OPEN'
      });
      sessionId = sess.id;

      await DeviceService.registerDevice(tx, {
        registerId: reg.id,
        name: 'POS Terminal Sétif',
        deviceId
      });

      const prod = await tx.insert('products', { name: 'Mocassins Cuir' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'MOC-CUI-MARRON-42',
        size: '42',
        color: 'Marron',
        cost_price: 350000n,
        sale_price: 650000n // 6,500 DA
      });
      variantId = variant.id;

      // Initial server stock = 5
      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: locationId,
        quantity: 5,
        movementType: 'IN',
        costPriceCentimes: 350000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      // Grant Device allowance = 3
      await StockAllowanceService.grantAllowance(tx, {
        deviceId,
        variantId: variant.id,
        locationId,
        allowanceQty: 3
      });
    });
  });

  await t.test('CRITICAL TEST 42: Device sells 3 offline while server sells all 5 elsewhere -> STOCK_CONFLICT & NO NEGATIVE STOCK (INV-08-16)', async () => {
    // 1. Device A records offline sale of 3 units
    const outbox = new LocalOutbox({ deviceId, tenantId });
    const op = outbox.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.POS_SALE,
      payload: {
        sessionId,
        locationId,
        cashierId,
        items: [{ variantId, quantity: 3, unitPriceCentimes: 650000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 1950000n }]
      }
    });

    // 2. Meanwhile on Server, another transaction sells out all 5 units
    await db.withTenant({ tenantId }, async (tx) => {
      await applyStockMovement(tx, {
        variantId,
        locationId,
        quantity: -5,
        movementType: 'OUT',
        costPriceCentimes: 350000n,
        reason: MOVEMENT_REASONS.POS_SALE
      });

      // Available server stock is now 0
      const level = await tx.query('stock_levels', sl => sl.variant_id === variantId && sl.location_id === locationId);
      assert.strictEqual(level[0].on_hand, 0);
    });

    // 3. Device A reconnects and attempts sync
    let syncResult = null;
    await db.withTenant({ tenantId }, async (tx) => {
      syncResult = await SyncEngine.syncBatch(tx, {
        deviceId,
        operations: [op]
      });
    });

    // Verify sync result flagged as STOCK_CONFLICT
    assert.strictEqual(syncResult.acknowledgements.length, 1);
    const ack = syncResult.acknowledgements[0];
    assert.strictEqual(ack.status, OUTBOX_STATUSES.CONFLICT);
    assert.strictEqual(ack.conflictCode, CONFLICT_TYPES.STOCK_CONFLICT);
    assert.ok(ack.error.includes('Insufficient inventory on server'));

    // Verify Invariants (INV-08-16):
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. ZERO NEGATIVE STOCK: On hand stock remains strictly 0 (never negative!)
      const level = await tx.query('stock_levels', sl => sl.variant_id === variantId && sl.location_id === locationId);
      assert.strictEqual(level[0].on_hand, 0, 'Stock level remained 0, never allowed negative stock (INV-08-16)');

      // 2. Conflict recorded in sync_conflicts table for review
      const conflicts = await tx.query('sync_conflicts', c => c.tenant_id === tenantId && c.operation_id === op.operationId);
      assert.strictEqual(conflicts.length, 1, 'Conflict recorded in database (INV-08-08)');
      assert.strictEqual(conflicts[0].conflict_type, CONFLICT_TYPES.STOCK_CONFLICT);
      assert.strictEqual(conflicts[0].status, 'PENDING_REVIEW');
    });
  });

  await t.test('INV-08-10 & INV-08-15: Controlled Manager Conflict Resolution (Cashier blocked, Manager cancels conflict)', async () => {
    let conflictId = null;

    await db.withTenant({ tenantId }, async (tx) => {
      const pending = await ConflictService.listPendingConflicts(tx);
      assert.strictEqual(pending.length, 1);
      conflictId = pending[0].id;

      // 1. Cashier attempting to resolve conflict is REJECTED
      await assert.rejects(
        async () => {
          await ConflictService.resolveConflict(tx, {
            conflictId,
            action: CONFLICT_RESOLUTION_ACTIONS.CANCEL,
            actorRole: ROLES.CASHIER,
            actorId: cashierId
          });
        },
        /Access Denied: Cashier or Stock Clerk cannot resolve sync conflicts/
      );

      // 2. Manager resolves conflict with explicit audit
      const resolved = await ConflictService.resolveConflict(tx, {
        conflictId,
        action: CONFLICT_RESOLUTION_ACTIONS.CANCEL,
        notes: 'Stock was already depleted; contact customer for refund or alternate item',
        actorRole: ROLES.MANAGER,
        actorId: managerId
      });

      assert.strictEqual(resolved.status, 'RESOLVED');
      assert.strictEqual(resolved.resolution_action, CONFLICT_RESOLUTION_ACTIONS.CANCEL);

      // Verify audit log
      const audits = await tx.query('audit_logs', a => a.entity_id === conflictId && a.action === 'SYNC_CONFLICT_RESOLVED');
      assert.strictEqual(audits.length, 1, 'Audit log written for manager conflict resolution');
    });

    // Verify pending conflicts list is now empty
    await db.withTenant({ tenantId }, async (tx) => {
      const pending = await ConflictService.listPendingConflicts(tx);
      assert.strictEqual(pending.length, 0);
    });
  });
});
