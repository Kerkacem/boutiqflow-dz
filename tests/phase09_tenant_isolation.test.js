const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { processSale } = require('../src/pos/register');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const { ReportingService, ExportService } = require('../src/reporting');

test('Phase 09 — Strict Tenant Isolation & Anti-Leakage Suite (INV-09-03, INV-09-20, Section 51)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  await t.test('Setup: Seed sales in Tenant A (1,000,000 DA) and Tenant B (5,000 DA)', async () => {
    // 1. Tenant A: 1,000,000 DA revenue
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Alger A' });
      const reg = await tx.insert('cash_registers', { name: 'Reg A', location_id: loc.id });
      const sess = await tx.insert('register_sessions', { register_id: reg.id, opening_float_centimes: 100000n, status: 'OPEN' });
      const prod = await tx.insert('products', { name: 'Costume Luxe' });
      const v = await tx.insert('product_variants', { product_id: prod.id, sku: 'COS-01', cost_price: 60000000n, sale_price: 100000000n });

      await applyStockMovement(tx, { variantId: v.id, locationId: loc.id, qty: 10, movementType: 'IN', reason: MOVEMENT_REASONS.RECEIVING });

      await processSale(tx, {
        sessionId: sess.id,
        registerId: reg.id,
        locationId: loc.id,
        cashierId: 'usr-a',
        items: [{ variantId: v.id, qty: 1, quantity: 1, unitPriceCentimes: 100000000n }], // 1,000,000 DA
        payments: [{ tenderType: 'CASH', amountCentimes: 100000000n }],
        idempotencyKey: 'SALE-TENANT-A-01'
      });
    });

    // 2. Tenant B: 5,000 DA revenue
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Oran B' });
      const reg = await tx.insert('cash_registers', { name: 'Reg B', location_id: loc.id });
      const sess = await tx.insert('register_sessions', { register_id: reg.id, opening_float_centimes: 100000n, status: 'OPEN' });
      const prod = await tx.insert('products', { name: 'Chemise Simple' });
      const v = await tx.insert('product_variants', { product_id: prod.id, sku: 'CHE-01', cost_price: 300000n, sale_price: 500000n });

      await applyStockMovement(tx, { variantId: v.id, locationId: loc.id, qty: 10, movementType: 'IN', reason: MOVEMENT_REASONS.RECEIVING });

      await processSale(tx, {
        sessionId: sess.id,
        registerId: reg.id,
        locationId: loc.id,
        cashierId: 'usr-b',
        items: [{ variantId: v.id, qty: 1, quantity: 1, unitPriceCentimes: 500000n }], // 5,000 DA
        payments: [{ tenderType: 'CASH', amountCentimes: 500000n }],
        idempotencyKey: 'SALE-TENANT-B-01'
      });
    });
  });

  await t.test('CRITICAL TENANT TEST (Section 51): Tenant A report returns exactly 1,000,000 DA, never 1,005,000 DA', async () => {
    // Query Tenant A report
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const summaryA = await ReportingService.getSalesSummary(tx);
      assert.strictEqual(summaryA.grossSalesCentimes, 100000000n, 'Tenant A revenue is exactly 1,000,000 DA');
      assert.strictEqual(summaryA.transactionsCount, 1);

      const profitA = await ReportingService.getProfitSummary(tx);
      assert.strictEqual(profitA.revenueCentimes, 100000000n, 'Tenant A profit revenue is 1,000,000 DA');
    });

    // Query Tenant B report
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const summaryB = await ReportingService.getSalesSummary(tx);
      assert.strictEqual(summaryB.grossSalesCentimes, 500000n, 'Tenant B revenue is exactly 5,000 DA');
      assert.strictEqual(summaryB.transactionsCount, 1);
    });
  });

  await t.test('INV-09-20: User-supplied tenantId query parameter is strictly rejected as authority boundary', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // User in Tenant A context attempts to supply filters.tenantId = tenantB
      await assert.rejects(
        async () => {
          await ReportingService.getSalesSummary(tx, { tenantId: tenantB });
        },
        /Security Violation: User-supplied tenantId does not match authenticated context/
      );

      await assert.rejects(
        async () => {
          await ReportingService.getProfitSummary(tx, { tenantId: tenantB });
        },
        /Security Violation: User-supplied tenantId does not match authenticated context/
      );
    });
  });
});
