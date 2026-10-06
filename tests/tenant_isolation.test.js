const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Tenant Isolation & Row-Level-Security (RLS) Verification', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();
  const userA = generateUUIDv7();
  const userB = generateUUIDv7();

  let productAId = null;

  await t.test('Tenant A creates products in their isolated scope', async () => {
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      const product = await tx.insert('products', {
        name: 'Veste Jean Homme Vintage',
        category: 'Vestes',
        brand: 'Boutique DZ'
      });
      assert.ok(product.id, 'Product should receive generated UUIDv7');
      assert.strictEqual(product.tenant_id, tenantA, 'Product tenant_id must match session tenant');
      productAId = product.id;

      // Tenant A can query their own product
      const results = await tx.query('products');
      assert.strictEqual(results.length, 1, 'Tenant A should see 1 product');
      assert.strictEqual(results[0].id, productAId);
    });
  });

  await t.test('Tenant B cannot see Tenant A products (Table Query)', async () => {
    await db.withTenant({ tenantId: tenantB, userId: userB }, async (tx) => {
      const results = await tx.query('products');
      assert.strictEqual(results.length, 0, 'Tenant B must see 0 products (RLS isolation)');
    });
  });

  await t.test('Tenant B cannot fetch Tenant A product by exact ID (Direct Lookup)', async () => {
    await db.withTenant({ tenantId: tenantB, userId: userB }, async (tx) => {
      const product = await tx.findById('products', productAId);
      assert.strictEqual(product, null, 'Direct lookup of other tenant ID must return null');
    });
  });

  await t.test('Tenant B cannot update Tenant A product', async () => {
    await db.withTenant({ tenantId: tenantB, userId: userB }, async (tx) => {
      const updated = await tx.update('products', productAId, { name: 'Hacked Title' });
      assert.strictEqual(updated, null, 'Tenant B cannot update Tenant A record');
    });

    // Verify product was not altered
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      const product = await tx.findById('products', productAId);
      assert.strictEqual(product.name, 'Veste Jean Homme Vintage', 'Product title must remain unchanged');
    });
  });

  await t.test('Tenant B cannot delete Tenant A product', async () => {
    await db.withTenant({ tenantId: tenantB, userId: userB }, async (tx) => {
      const deleted = await tx.delete('products', productAId);
      assert.strictEqual(deleted, false, 'Tenant B cannot delete Tenant A record');
    });

    // Verify product still exists in Tenant A scope
    await db.withTenant({ tenantId: tenantA, userId: userA }, async (tx) => {
      const product = await tx.findById('products', productAId);
      assert.ok(product, 'Product must still exist');
    });
  });

  await t.test('MUTATION TEST: Deliberately breaking RLS leaks data and causes test failure', async () => {
    // Deliberately disable RLS
    db._setRLSEnabled(false);

    try {
      await db.withTenant({ tenantId: tenantB, userId: userB }, async (tx) => {
        const leaked = await tx.query('products');
        // When RLS is disabled, data leaks:
        assert.strictEqual(leaked.length, 1, 'Without RLS, data leaks across tenants');
      });
    } finally {
      // Re-enable RLS
      db._setRLSEnabled(true);
    }

    // Verify isolation restored
    await db.withTenant({ tenantId: tenantB, userId: userB }, async (tx) => {
      const isolated = await tx.query('products');
      assert.strictEqual(isolated.length, 0, 'Re-enabling RLS restores complete isolation');
    });
  });
});
