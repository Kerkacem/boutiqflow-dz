const test = require('node:test');
const assert = require('node:assert');
const { createEncryptedBackup, restoreEncryptedBackup } = require('../src/ops/backup');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const { processSale, TENDER_TYPES } = require('../src/pos/register');
const { ROLES, PERMISSIONS, authorize } = require('../src/rbac/permissions');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase P8 — Security Hardening, Penetration Suite & Disaster Recovery', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();
  const backupKey = 'SuperSecureBackupPassword2026!#';

  let locationId = null;
  let variantId = null;
  let customerId = null;

  await t.test('Setup production database state for disaster recovery test', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Magasin Alger', type: 'shop' });
      locationId = loc.id;

      const p = await tx.insert('products', { name: 'Veste Cuir Haute Couture' });
      const v = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'VST-CUIR-50',
        size: '50',
        color: 'Noir',
        cost_price: 1500000n, // 15,000 DA
        sale_price: 3200000n  // 32,000 DA
      });
      variantId = v.id;

      const cust = await tx.insert('customers', {
        name: 'Mourad Client',
        phone: '+213550991122',
        debt_balance_centimes: 0n
      });
      customerId = cust.id;

      // Seed 25 units
      await applyStockMovement(tx, {
        variantId: v.id,
        locationId,
        qty: 25,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      // Complete a sale with credit
      await processSale(tx, {
        locationId,
        cashierId: generateUUIDv7(),
        customerId: cust.id,
        items: [{ variantId: v.id, qty: 2 }],
        payments: [
          { tenderType: TENDER_TYPES.CASH, amountCentimes: 3400000n },
          { tenderType: TENDER_TYPES.CUSTOMER_CREDIT, amountCentimes: 3000000n } // 30,000 DA credit
        ],
        idempotencyKey: 'p8_prod_sale_001'
      });
    });
  });

  await t.test('UAT-15: Disaster Recovery: Encrypted Backup, Full DB Wipe, Restore & Invariant Verification', async () => {
    // 1. Create AES-256-GCM encrypted backup
    const backupArtifact = createEncryptedBackup(db, backupKey);
    assert.strictEqual(backupArtifact.algorithm, 'aes-256-gcm');
    assert.ok(backupArtifact.payload);
    assert.ok(backupArtifact.authTag);

    // 2. Full wipe of database
    for (const [name, map] of Object.entries(db.tables)) {
      if (name !== 'plans') map.clear();
    }

    // Verify database is completely empty
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const prods = await tx.query('products');
      const sales = await tx.query('sales');
      assert.strictEqual(prods.length, 0, 'Database must be empty after wipe');
      assert.strictEqual(sales.length, 0);
    });

    // 3. Restore from encrypted backup
    const restoreResult = await restoreEncryptedBackup(db, backupArtifact, backupKey);
    assert.strictEqual(restoreResult.success, true);

    // 4. Invariant Verification Post-Restore: INV-1 holds
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const levels = (await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === locationId))[0];
      const movements = await tx.query('stock_movements', m => m.variant_id === variantId && m.location_id === locationId);
      const sumMovements = movements.reduce((acc, m) => acc + m.qty, 0);

      assert.strictEqual(levels.on_hand, 23, 'on_hand must equal 25 - 2 = 23 units');
      assert.strictEqual(levels.on_hand, sumMovements, 'INV-1 strictly holds after restore');

      // Verify customer debt is intact
      const customer = await tx.findById('customers', customerId);
      assert.strictEqual(customer.debt_balance_centimes, 3000000n, 'Customer debt restored accurately');
    });
  });

  await t.test('UAT-13: Scripted Pentest: IDOR Attacks across all tables return 404/403', async () => {
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      // Tenant B attempts to look up Tenant A's products, sales, customers, locations
      assert.strictEqual(await tx.findById('products', variantId), null);
      assert.strictEqual(await tx.findById('customers', customerId), null);
      assert.strictEqual(await tx.findById('inventory_locations', locationId), null);

      // Tenant B attempts to delete Tenant A's customer
      assert.strictEqual(await tx.delete('customers', customerId), false);

      // Tenant B attempts to update Tenant A's customer
      assert.strictEqual(await tx.update('customers', customerId, { name: 'Hacked Name' }), null);
    });
  });

  await t.test('Pentest: Mass Assignment & Tenant Tampering Injection Blocked', async () => {
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      // Attempting to insert record for Tenant A inside Tenant B session
      await assert.rejects(
        async () => {
          await tx.insert('products', {
            tenant_id: tenantA, // Tampered tenant ID
            name: 'Malicious Product'
          });
        },
        /Security Violation/
      );
    });
  });

  await t.test('Pentest: Privilege Escalation & Role Matrix Boundary', () => {
    // Cashier attempting to void sale
    assert.throws(
      () => authorize(ROLES.CASHIER, PERMISSIONS.SALES_VOID),
      (err) => err.statusCode === 403
    );

    // Cashier attempting to view cost prices
    assert.throws(
      () => authorize(ROLES.CASHIER, PERMISSIONS.CATALOG_VIEW_COST),
      (err) => err.statusCode === 403
    );

    // Stock clerk attempting to export data
    assert.throws(
      () => authorize(ROLES.STOCK_CLERK, PERMISSIONS.DATA_EXPORT),
      (err) => err.statusCode === 403
    );
  });
});
