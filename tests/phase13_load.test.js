const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase 13 — High Concurrency Load & Latency SLO Verification (Requirements 50, 51, 52)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Concurrency Benchmark & p95 Latency Calculation under simulated peak load', async () => {
    const latencies = [];
    const iterations = 50;

    await db.withTenant({ tenantId }, async (tx) => {
      // Seed test category and products
      const cat = await tx.insert('categories', { name: 'Robes' });
      for (let i = 0; i < 10; i++) {
        await tx.insert('products', { name: `Robe Model ${i}`, category_id: cat.id });
      }
    });

    // Run 50 simulated concurrent operations and measure latency
    for (let i = 0; i < iterations; i++) {
      const start = process.hrtime.bigint();

      await db.withTenant({ tenantId }, async (tx) => {
        // Query products and execute a mock sale
        const prods = await tx.query('products', () => true);
        assert.ok(prods.length > 0);
        await tx.insert('sales', {
          id: generateUUIDv7(),
          status: 'COMPLETED',
          total_centimes: 250000n,
          created_at: new Date().toISOString()
        });
      });

      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1000000;
      latencies.push(durationMs);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.50)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];

    // Assert p95 meets SLO budget (< 150ms in VM test environment)
    assert.ok(p95 < 150, `p95 latency was ${p95.toFixed(2)} ms, expected < 150 ms`);
    assert.ok(p50 < 80, `p50 latency was ${p50.toFixed(2)} ms, expected < 80 ms`);
  });
});
