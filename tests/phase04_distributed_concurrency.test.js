const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { openRegisterSession } = require('../src/pos/register');
const { receiveStock, getVariantStock } = require('../src/inventory/ledger');

test('Phase 04 — Distributed Multi-Process Concurrency Suite (INV-03-10, INV-04-10)', async (t) => {
  const dbPath = path.join(os.tmpdir(), `boutiqflow_dist_db_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
  const tenantId = generateUUIDv7();
  let locationId, cashierId, sessionId, variantId;

  // Cleanup shared file on start and finish
  const cleanupDbFile = () => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch (e) {}
  };
  cleanupDbFile();
  t.after(cleanupDbFile);

  await t.test('Setup shared persistent database environment and seed Stock = 1', async () => {
    const db = new MahalDatabase({ persistencePath: dbPath });

    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Alger Distributed' });
      locationId = loc.id;

      const user = await tx.insert('users', { name: 'Caissier Multi-Worker', role: 'cashier', email: 'worker@pos.dz' });
      cashierId = user.id;

      const prod = await tx.insert('products', { name: 'Pièce Unique Haute Couture' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'ROB-PIECE-UNIQUE',
        size: '38',
        color: 'Or',
        cost_price: 1000000n,
        sale_price: 2500000n // 25,000 DA
      });
      variantId = variant.id;

      // Seed exactly 1 unit
      await receiveStock(tx, { variantId, locationId, quantity: 1 });

      const session = await openRegisterSession(tx, {
        locationId,
        cashierId,
        openingCashCentimes: 500000n
      });
      sessionId = session.id;
    });

    assert.ok(fs.existsSync(dbPath), 'Shared database file must be created on disk');
  });

  await t.test('CRITICAL TEST: Stock = 1, Worker A and Worker B in separate processes execute concurrent sales', async () => {
    const workerScript = path.resolve(__dirname, '../scripts/worker_pos_sale.js');

    const spawnWorker = (workerId) => {
      return new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [
          workerScript,
          '--dbPath', dbPath,
          '--tenantId', tenantId,
          '--locationId', locationId,
          '--sessionId', sessionId,
          '--cashierId', cashierId,
          '--variantId', variantId,
          '--workerId', workerId
        ]);

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });

        child.on('close', code => {
          try {
            const parsed = JSON.parse(stdout.trim());
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse worker output: ${stdout} | stderr: ${stderr}`));
          }
        });
      });
    };

    // Launch Worker A and Worker B concurrently in separate operating system processes
    const [resultA, resultB] = await Promise.all([
      spawnWorker('Worker-A'),
      spawnWorker('Worker-B')
    ]);

    // 1. Verify separate OS processes
    assert.notStrictEqual(resultA.pid, resultB.pid, 'Worker A and Worker B must have distinct OS process IDs');

    // 2. Exactly ONE worker must succeed, exactly ONE must fail
    const results = [resultA, resultB];
    const successes = results.filter(r => r.success === true);
    const failures = results.filter(r => r.success === false);

    assert.strictEqual(successes.length, 1, 'Exactly 1 worker process must succeed in claiming the last unit');
    assert.strictEqual(failures.length, 1, 'Exactly 1 worker process must fail with insufficient stock');
    assert.match(failures[0].error, /Insufficient inventory/);

    // 3. Verify final stock in shared database
    const db = new MahalDatabase({ persistencePath: dbPath });
    await db.withTenant({ tenantId }, async (tx) => {
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 0, 'Final onHand must be strictly 0');
      assert.strictEqual(stock.reserved, 0, 'Final reserved must be strictly 0');
      assert.strictEqual(stock.available, 0, 'Final available must be strictly 0');

      const allSales = await tx.query('sales', s => s.location_id === locationId);
      assert.strictEqual(allSales.length, 1, 'Exactly 1 sale recorded in shared database');
    });
  });

  await t.test('Multi-Worker Scale Test: Stock = 2, 4 separate worker processes compete concurrently', async () => {
    const workerScript = path.resolve(__dirname, '../scripts/worker_pos_sale.js');
    let variant2Id;

    // Seed variant with 2 units
    const db = new MahalDatabase({ persistencePath: dbPath });
    await db.withTenant({ tenantId }, async (tx) => {
      const p = await tx.insert('products', { name: 'Paire Chaussures Cuir' });
      const v = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'CHS-CUIR-BRN-42',
        size: '42',
        color: 'Marron',
        cost_price: 400000n,
        sale_price: 800000n
      });
      variant2Id = v.id;
      await receiveStock(tx, { variantId: variant2Id, locationId, quantity: 2 });
    });

    const spawnWorker = (workerId) => {
      return new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [
          workerScript,
          '--dbPath', dbPath,
          '--tenantId', tenantId,
          '--locationId', locationId,
          '--sessionId', sessionId,
          '--cashierId', cashierId,
          '--variantId', variant2Id,
          '--workerId', workerId
        ]);

        let stdout = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.on('close', () => {
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch (e) {
            reject(new Error(`Failed to parse worker ${workerId}: ${stdout}`));
          }
        });
      });
    };

    // Launch 4 distinct processes
    const workerPromises = ['W1', 'W2', 'W3', 'W4'].map(id => spawnWorker(id));
    const results = await Promise.all(workerPromises);

    const distinctPids = new Set(results.map(r => r.pid));
    assert.strictEqual(distinctPids.size, 4, 'All 4 workers must run in distinct OS processes');

    const successes = results.filter(r => r.success === true);
    const failures = results.filter(r => r.success === false);

    assert.strictEqual(successes.length, 2, 'Exactly 2 sales must succeed for Stock = 2');
    assert.strictEqual(failures.length, 2, 'Exactly 2 sales must fail with insufficient stock');

    await db.withTenant({ tenantId }, async (tx) => {
      const stock = await getVariantStock(tx, variant2Id, locationId);
      assert.strictEqual(stock.onHand, 0, 'Final onHand must be strictly 0');
      assert.strictEqual(stock.available, 0, 'Final available must be strictly 0');
    });
  });
});
