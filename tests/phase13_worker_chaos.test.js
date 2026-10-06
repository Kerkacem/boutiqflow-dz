const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { receiveStock, getVariantStock } = require('../src/inventory/ledger');

test('Phase 13 — Worker Chaos & Crash Recovery (INV-13-09, Requirement 23)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Worker crash before transaction commit leaves zero partial mutations (INV-13-09)', async () => {
    let variantId = null;
    let locationId = null;

    // Setup variant and initial stock of 10
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Main Shop' });
      locationId = loc.id;
      const cat = await tx.insert('categories', { name: 'Pantalons' });
      const prod = await tx.insert('products', { name: 'Jean Slim', category_id: cat.id });
      const v = await tx.insert('product_variants', { product_id: prod.id, sku: 'JEAN-001', size: '32', color: 'Bleu' });
      variantId = v.id;

      await receiveStock(tx, {
        tenantId,
        locationId,
        variantId,
        quantity: 10,
        unitCostCentimes: 150000n,
        operationId: 'OP-INIT-STOCK'
      });
    });

    // Simulated Worker: starts order checkout, does external call, then crashes before committing
    try {
      await db.withTenant({ tenantId }, async (tx) => {
        // Step A: Stage order
        await tx.insert('online_orders', {
          id: generateUUIDv7(),
          status: 'PENDING_CONFIRMATION',
          total_centimes: 350000n
        });

        // Step B: Simulate external API call success
        const externalSuccess = true;

        // Step C: WORKER CRASH (Simulated process kill / unhandled crash)
        throw new Error('WORKER_PROCESS_KILLED_SIGKILL');
      });
    } catch (e) {
      assert.strictEqual(e.message, 'WORKER_PROCESS_KILLED_SIGKILL');
    }

    // Verify recovery after crash: zero partial orders, stock remains intact at exactly 10
    await db.withTenant({ tenantId }, async (tx) => {
      const orders = await tx.query('online_orders', () => true);
      assert.strictEqual(orders.length, 0, 'Rolled back transaction must leave zero orders');

      const level = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(level.onHand, 10);
      assert.strictEqual(level.reserved, 0);
      assert.strictEqual(level.available, 10);
    });
  });

  await t.test('2. Replayed job after crash achieves exactly 1 execution (Idempotent Recovery)', async () => {
    let executedCount = 0;
    const idempotencyKey = 'WORKER-JOB-RECOVERY-001';

    const executeJob = async (tx) => {
      const existing = await tx.query('processed_operations', p => p.operation_id === idempotencyKey);
      if (existing.length > 0) {
        return { replayed: true, result: existing[0].result };
      }

      executedCount++;
      const result = { success: true, processedItem: 'INVOICE_SYNC_OK' };

      await tx.insert('processed_operations', {
        id: generateUUIDv7(),
        operation_id: idempotencyKey,
        result,
        created_at: new Date().toISOString()
      });

      return { replayed: false, result };
    };

    // First attempt commits
    await db.withTenant({ tenantId }, async (tx) => {
      const res1 = await executeJob(tx);
      assert.strictEqual(res1.replayed, false);
    });

    // Worker restarted after crash, retries the same job
    await db.withTenant({ tenantId }, async (tx) => {
      const res2 = await executeJob(tx);
      assert.strictEqual(res2.replayed, true);
    });

    // Exactly 1 business execution
    assert.strictEqual(executedCount, 1);
  });
});
