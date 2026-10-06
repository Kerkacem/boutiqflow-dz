const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const {
  StockAllowanceService,
  DeviceService
} = require('../src/offline');

test('Phase 08 — Offline Stock Allowance & Reservation Budget Suite (INV-08-25, Requirement 8)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let locationA = null;
  let variantA = null;
  const deviceA1 = `POS-ALLOWANCE-${generateUUIDv7()}`;
  const deviceA2 = `POS-ALLOWANCE-${generateUUIDv7()}`;

  await t.test('Setup: Seed variant with 10 units in stock', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Dépôt Oran', type: 'shop' });
      locationA = loc.id;

      const reg1 = await tx.insert('cash_registers', { name: 'Caisse 1', location_id: locationA });
      const reg2 = await tx.insert('cash_registers', { name: 'Caisse 2', location_id: locationA });

      await DeviceService.registerDevice(tx, { registerId: reg1.id, name: 'Caisse 1 POS', deviceId: deviceA1 });
      await DeviceService.registerDevice(tx, { registerId: reg2.id, name: 'Caisse 2 POS', deviceId: deviceA2 });

      const prod = await tx.insert('products', { name: 'Robe Brodée' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'ROB-BRO-BLANC-M',
        size: 'M',
        color: 'Blanc',
        cost_price: 200000n,
        sale_price: 450000n
      });
      variantA = variant.id;

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: locationA,
        quantity: 10,
        qty: 10,
        movementType: 'IN',
        costPriceCentimes: 200000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });
  });

  await t.test('Grant allowance within available server stock (Device 1 = 3, Device 2 = 2)', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Grant 3 units to Device 1
      const grant1 = await StockAllowanceService.grantAllowance(tx, {
        deviceId: deviceA1,
        variantId: variantA,
        locationId: locationA,
        allowanceQty: 3,
        grantedBy: 'Admin Oran'
      });
      assert.strictEqual(grant1.remaining_allowance, 3);
      assert.strictEqual(grant1.allocated_allowance, 3);

      // Grant 2 units to Device 2
      const grant2 = await StockAllowanceService.grantAllowance(tx, {
        deviceId: deviceA2,
        variantId: variantA,
        locationId: locationA,
        allowanceQty: 2,
        grantedBy: 'Admin Oran'
      });
      assert.strictEqual(grant2.remaining_allowance, 2);

      const rem1 = await StockAllowanceService.getRemainingAllowance(tx, {
        deviceId: deviceA1,
        variantId: variantA,
        locationId: locationA
      });
      assert.strictEqual(rem1, 3);

      const rem2 = await StockAllowanceService.getRemainingAllowance(tx, {
        deviceId: deviceA2,
        variantId: variantA,
        locationId: locationA
      });
      assert.strictEqual(rem2, 2);
    });
  });

  await t.test('Cannot grant allowance exceeding available server stock', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => {
          await StockAllowanceService.grantAllowance(tx, {
            deviceId: deviceA1,
            variantId: variantA,
            locationId: locationA,
            allowanceQty: 50 // Server only has 10
          });
        },
        /Insufficient available stock/
      );
    });
  });

  await t.test('Consume allowance progressively and reject on exhaustion', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Device 1 consumes 1 unit
      const res1 = await StockAllowanceService.consumeAllowance(tx, {
        deviceId: deviceA1,
        variantId: variantA,
        locationId: locationA,
        quantity: 1
      });
      assert.strictEqual(res1.allowed, true);
      assert.strictEqual(res1.remaining, 2);

      // Device 1 consumes remaining 2 units
      const res2 = await StockAllowanceService.consumeAllowance(tx, {
        deviceId: deviceA1,
        variantId: variantA,
        locationId: locationA,
        quantity: 2
      });
      assert.strictEqual(res2.allowed, true);
      assert.strictEqual(res2.remaining, 0);

      // Device 1 attempts to consume 1 more unit -> REJECTED
      const res3 = await StockAllowanceService.consumeAllowance(tx, {
        deviceId: deviceA1,
        variantId: variantA,
        locationId: locationA,
        quantity: 1
      });
      assert.strictEqual(res3.allowed, false);
      assert.strictEqual(res3.reason, 'INSUFFICIENT_ALLOWANCE');
      assert.strictEqual(res3.remaining, 0);
    });
  });

  await t.test('Device with no allowance is rejected immediately', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const res = await StockAllowanceService.consumeAllowance(tx, {
        deviceId: 'UNKNOWN_DEVICE_99',
        variantId: variantA,
        locationId: locationA,
        quantity: 1
      });
      assert.strictEqual(res.allowed, false);
      assert.strictEqual(res.reason, 'NO_ALLOWANCE_GRANTED');
    });
  });

  await t.test('Tenant isolation: allowances are strictly tenant-scoped (INV-08-09, INV-08-23)', async () => {
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      // Tenant B queries allowance for deviceA1
      const rem = await StockAllowanceService.getRemainingAllowance(tx, {
        deviceId: deviceA1,
        variantId: variantA,
        locationId: locationA
      });
      assert.strictEqual(rem, 0, 'Tenant B cannot see Tenant A allowance');

      const consumeRes = await StockAllowanceService.consumeAllowance(tx, {
        deviceId: deviceA1,
        variantId: variantA,
        locationId: locationA,
        quantity: 1
      });
      assert.strictEqual(consumeRes.allowed, false);
      assert.strictEqual(consumeRes.reason, 'NO_ALLOWANCE_GRANTED');
    });
  });
});
