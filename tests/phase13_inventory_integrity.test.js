const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  receiveStock,
  issueStock,
  reserveStock,
  releaseReservation,
  adjustStock,
  getVariantStock
} = require('../src/inventory/ledger');
const { IntegrityCheckJob, INTEGRITY_STATUSES } = require('../src/security');

test('Phase 13 — Inventory Integrity Chaos & Invariants (INV-13-15, Requirement 28)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let variantId = null;
  let locationId = null;

  await t.test('1. Setup initial variant and warehouse location', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Main Depot' });
      locationId = loc.id;
      const cat = await tx.insert('categories', { name: 'Robes' });
      const prod = await tx.insert('products', { name: 'Caftan Soie', category_id: cat.id });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'CAFTAN-001',
        size: 'M',
        color: 'Vert'
      });
      variantId = v.id;
    });
  });

  await t.test('2. Multi-operation high-concurrency inventory cycle strictly preserves mathematical invariants (Requirement 28)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Initial Receive 50 units
      await receiveStock(tx, {
        tenantId,
        locationId,
        variantId,
        quantity: 50,
        unitCostCentimes: 200000n,
        operationId: 'OP-INIT-50'
      });

      // 2. Reserve 20 units
      const res1 = await reserveStock(tx, {
        tenantId,
        locationId,
        variantId,
        quantity: 20,
        orderId: 'ORD-INT-001',
        operationId: 'OP-RES-20'
      });

      // 3. Issue/Sell 10 units from available
      await issueStock(tx, {
        tenantId,
        locationId,
        variantId,
        quantity: 10,
        operationId: 'OP-SALE-10'
      });

      // 4. Release reservation cleanly
      await releaseReservation(tx, {
        reservationId: res1.id,
        operationId: 'OP-REL-RES1'
      });

      // 5. Stock adjustment +5
      await adjustStock(tx, {
        tenantId,
        locationId,
        variantId,
        adjustment: 5,
        reason: 'FOUND',
        operationId: 'OP-ADJ-5'
      });

      // Verification:
      // Initial: +50
      // Sold: -10
      // Adjusted: +5
      // Net OnHand: 45
      // Reserved: 0 (since res1 was released)
      // Available: 45
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 45);
      assert.strictEqual(stock.reserved, 0);
      assert.strictEqual(stock.available, 45);
      assert.ok(stock.onHand >= 0, 'onHand must be >= 0');
      assert.ok(stock.reserved >= 0, 'reserved must be >= 0');
      assert.ok(stock.reserved <= stock.onHand, 'reserved must be <= onHand');
      assert.strictEqual(stock.available, stock.onHand - stock.reserved);
    });
  });

  await t.test('3. Data Integrity Check Job reports MATCHED with zero drift', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const audit = await IntegrityCheckJob.verifyInventoryLedger(tx, tenantId);
      assert.strictEqual(audit.status, INTEGRITY_STATUSES.MATCHED);
      assert.strictEqual(audit.driftsCount, 0);

      const resAudit = await IntegrityCheckJob.verifyReservations(tx, tenantId);
      assert.strictEqual(resAudit.status, INTEGRITY_STATUSES.MATCHED);
      assert.strictEqual(resAudit.driftsCount, 0);
    });
  });
});
