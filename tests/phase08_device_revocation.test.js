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
  CONFLICT_TYPES,
  DEVICE_STATUSES
} = require('../src/offline');

test('Phase 08 — Device Revocation & Tenant Binding Suite (INV-08-17, INV-08-23, CRITICAL TEST 41)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();
  const deviceId = `POS-REVOKE-${generateUUIDv7()}`;

  let locationId = null;
  let cashierId = null;
  let variantId = null;
  let sessionId = null;

  await t.test('Setup server state: register device and seed stock', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Tlemcen', type: 'shop' });
      locationId = loc.id;

      const user = await tx.insert('users', {
        name: 'Nacera Cashier',
        email: 'nacera@boutiqflow.dz',
        role: 'cashier',
        password_hash: 'hash'
      });
      cashierId = user.id;

      const reg = await tx.insert('cash_registers', { name: 'Caisse Tlemcen 1', location_id: locationId });
      const sess = await tx.insert('register_sessions', {
        register_id: reg.id,
        cashier_id: cashierId,
        opening_float_centimes: 500000n,
        status: 'OPEN'
      });
      sessionId = sess.id;

      await DeviceService.registerDevice(tx, {
        registerId: reg.id,
        name: 'POS Terminal Tlemcen',
        deviceId
      });

      const prod = await tx.insert('products', { name: 'Chedda Tlemcenia' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'CHE-TLE-OR-UNIQUE',
        size: 'Unique',
        color: 'Or',
        cost_price: 2500000n,
        sale_price: 4500000n // 45,000 DA
      });
      variantId = variant.id;

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: locationId,
        quantity: 5,
        movementType: 'IN',
        costPriceCentimes: 2500000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });
  });

  await t.test('CRITICAL TEST 41: Device creates sale offline -> Admin revokes device -> Sync rejected (INV-08-17)', async () => {
    // 1. Device creates sale while offline
    const outbox = new LocalOutbox({ deviceId, tenantId: tenantA });
    const op = outbox.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.POS_SALE,
      payload: {
        sessionId,
        locationId,
        cashierId,
        items: [{ variantId, quantity: 1, unitPriceCentimes: 4500000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 4500000n }]
      }
    });

    // 2. Administrator revokes device on server
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const revoked = await DeviceService.revokeDevice(tx, {
        deviceId,
        revokedBy: 'usr-admin-security',
        reason: 'Device hardware reported stolen'
      });
      assert.strictEqual(revoked.status, DEVICE_STATUSES.REVOKED);

      // Verify audit log
      const audit = await tx.query('audit_logs', a => a.action === 'DEVICE_REVOKED' && a.entity_id === deviceId);
      assert.strictEqual(audit.length, 1, 'Security audit logged for device revocation');
    });

    // 3. Stolen/revoked device reconnects and attempts to sync
    let syncRes = null;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      syncRes = await SyncEngine.syncBatch(tx, {
        deviceId,
        operations: [op]
      });
    });

    // Verify sync was strictly rejected
    assert.strictEqual(syncRes.success, false);
    assert.strictEqual(syncRes.deviceStatus, 'REVOKED');
    assert.strictEqual(syncRes.acknowledgements.length, 1);
    assert.strictEqual(syncRes.acknowledgements[0].status, OUTBOX_STATUSES.CONFLICT);
    assert.strictEqual(syncRes.acknowledgements[0].conflictCode, CONFLICT_TYPES.DEVICE_REVOKED);

    // Verify ZERO mutations occurred on server (INV-08-17):
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 0 sales created
      const sales = await tx.query('sales', s => s.tenant_id === tenantA);
      assert.strictEqual(sales.length, 0, 'No sales committed on server for revoked device');

      // Stock remains completely untouched at 5
      const level = await tx.query('stock_levels', sl => sl.variant_id === variantId && sl.location_id === locationId);
      assert.strictEqual(level[0].on_hand, 5, 'Inventory protected from revoked device');
    });
  });

  await t.test('INV-08-23: Cross-Tenant Device sync attempt is strictly rejected', async () => {
    // Attempting to sync deviceId from Tenant B throws TENANT_MISMATCH
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      await assert.rejects(
        async () => {
          await SyncEngine.syncBatch(tx, {
            deviceId,
            operations: [{
              operationId: 'op_hack_01',
              operationType: OFFLINE_OPERATIONS.POS_SALE,
              payload: {}
            }]
          });
        },
        /Security Violation: Device belongs to another tenant/
      );
    });
  });
});
