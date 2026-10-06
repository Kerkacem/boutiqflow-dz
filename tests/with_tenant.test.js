const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('withTenant Context & Transaction Lifecycle', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('Fails immediately when tenant context is missing', async () => {
    await assert.rejects(
      async () => {
        await db.withTenant(null, async () => {});
      },
      /tenantId is required/
    );

    await assert.rejects(
      async () => {
        await db.withTenant({}, async () => {});
      },
      /tenantId is required/
    );
  });

  await t.test('Rolls back inserts if an uncaught error occurs in callback', async () => {
    let attemptedId = null;

    await assert.rejects(
      async () => {
        await db.withTenant({ tenantId }, async (tx) => {
          const loc = await tx.insert('inventory_locations', {
            name: 'Magasin Alger Centre',
            type: 'shop'
          });
          attemptedId = loc.id;
          throw new Error('Simulated runtime failure mid-transaction');
        });
      },
      /Simulated runtime failure/
    );

    // Verify rollback
    await db.withTenant({ tenantId }, async (tx) => {
      const found = await tx.findById('inventory_locations', attemptedId);
      assert.strictEqual(found, null, 'Staged record must be rolled back on error');
    });
  });

  await t.test('Concurrent operations across different tenants remain isolated', async () => {
    const tenant1 = generateUUIDv7();
    const tenant2 = generateUUIDv7();

    const task1 = db.withTenant({ tenantId: tenant1 }, async (tx) => {
      await tx.insert('products', { name: 'Item Tenant 1' });
      const items = await tx.query('products');
      return items.length;
    });

    const task2 = db.withTenant({ tenantId: tenant2 }, async (tx) => {
      await tx.insert('products', { name: 'Item Tenant 2' });
      await tx.insert('products', { name: 'Item 2 Tenant 2' });
      const items = await tx.query('products');
      return items.length;
    });

    const [count1, count2] = await Promise.all([task1, task2]);
    assert.strictEqual(count1, 1, 'Tenant 1 should see exactly 1 item');
    assert.strictEqual(count2, 2, 'Tenant 2 should see exactly 2 items');
  });
});
