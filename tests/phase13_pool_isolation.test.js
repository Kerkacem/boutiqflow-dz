const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase 13 — Database Connection Pool Isolation (INV-13-05, Requirement 10)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  await t.test('1. Sequential requests on reused database connection preserve RLS isolation (INV-13-05)', async () => {
    let productAId = null;

    // Request 1: Tenant A inserts product
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const cat = await tx.insert('categories', { name: 'Femme' });
      const p = await tx.insert('products', {
        name: 'Tenant A Secret Dress',
        category_id: cat.id
      });
      productAId = p.id;
      assert.ok(productAId);
    });

    // Request 2: Tenant B runs on the same DB connection/pool immediately after Tenant A
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      // 1. Direct findById across tenant returns null
      const directLookup = await tx.findById('products', productAId);
      assert.strictEqual(directLookup, null);

      // 2. Query all products returns 0 records for Tenant B
      const allProducts = await tx.query('products', () => true);
      assert.strictEqual(allProducts.length, 0);

      // 3. Foreign tenant insert attempting to inject Tenant A ID throws security violation
      await assert.rejects(
        async () => tx.insert('products', {
          name: 'Malicious Cross-Tenant Product',
          tenant_id: tenantA
        }),
        /Security Violation: Cannot insert row for tenant/
      );

      // 4. Update attempt on Tenant A's product from Tenant B session returns null/fails
      const updateResult = await tx.update('products', productAId, { name: 'Tampered Name' });
      assert.strictEqual(updateResult, null);

      // 5. Delete attempt on Tenant A's product from Tenant B session returns false/null
      const deleteResult = await tx.delete('products', productAId);
      assert.strictEqual(deleteResult, false);
    });

    // Request 3: Back to Tenant A, verify product was untouched
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const prodA = await tx.findById('products', productAId);
      assert.ok(prodA);
      assert.strictEqual(prodA.name, 'Tenant A Secret Dress');
    });
  });
});
