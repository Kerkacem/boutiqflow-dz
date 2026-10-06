const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { createOnlineOrder } = require('../src/orders/orders');
const {
  PublicApiService,
  INTEGRATION_ERRORS,
  PUBLIC_API_VERSION
} = require('../src/integrations');

test('Phase 10 — Public API Security & Tenant Boundary (INV-10-16, INV-10-17, Critical Test 52)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let keyA = null;
  let keyB = null;

  await t.test('Setup: Create API Keys and Orders for Tenant A and Tenant B', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const prodA = await tx.insert('products', { name: 'Produit A', category: 'Mode' });
      const varA = await tx.insert('product_variants', {
        product_id: prodA.id,
        sku: 'SKU-A',
        barcode: '6131111111111',
        selling_price_cents: 500000n
      });

      keyA = await PublicApiService.createApiKey(tx, {
        name: 'Tenant A Key',
        scopes: ['orders:read', 'orders:write']
      });

      await createOnlineOrder(tx, {
        customerName: 'Client Tenant A',
        customerPhone: '0550111111',
        wilaya: 'Alger',
        commune: 'Bab El Oued',
        address: 'Rue 1',
        items: [
          { variantId: varA.id, productName: 'Article A', quantity: 1, unitPriceCentimes: 500000n }
        ],
        deliveryFeeCentimes: 50000n
      });
    });

    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const prodB = await tx.insert('products', { name: 'Produit B', category: 'Mode' });
      const varB = await tx.insert('product_variants', {
        product_id: prodB.id,
        sku: 'SKU-B',
        barcode: '6132222222222',
        selling_price_cents: 600000n
      });

      keyB = await PublicApiService.createApiKey(tx, {
        name: 'Tenant B Key',
        scopes: ['orders:read']
      });

      await createOnlineOrder(tx, {
        customerName: 'Client Tenant B',
        customerPhone: '0660222222',
        wilaya: 'Oran',
        commune: 'Es Senia',
        address: 'Rue 2',
        items: [
          { variantId: varB.id, productName: 'Article B', quantity: 1, unitPriceCentimes: 600000n }
        ],
        deliveryFeeCentimes: 60000n
      });
    });

    assert.ok(keyA.apiKey.startsWith('bf_live_'));
    assert.ok(keyB.apiKey.startsWith('bf_live_'));
  });

  await t.test('1. Authoritative Key Authentication & Secret Hashing (INV-10-16)', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Raw key validates
      const auth = await PublicApiService.authenticateKey(tx, keyA.apiKey, 'orders:read');
      assert.strictEqual(auth.tenantId, tenantA);

      // Raw secret is never stored plaintext in public_api_keys
      const storedKeys = await tx.query('public_api_keys', k => k.id === keyA.keyId);
      assert.strictEqual(storedKeys.length, 1);
      assert.strictEqual(storedKeys[0].hashed_secret.includes('bf_live_'), false);

      // Invalid key throws UNAUTHORIZED
      await assert.rejects(
        async () => PublicApiService.authenticateKey(tx, 'bf_live_invalid_secret_key', 'orders:read'),
        err => err.code === INTEGRATION_ERRORS.UNAUTHORIZED
      );

      // Missing scope throws FORBIDDEN
      await assert.rejects(
        async () => PublicApiService.authenticateKey(tx, keyA.apiKey, 'reports:read'),
        err => err.code === INTEGRATION_ERRORS.FORBIDDEN
      );
    });
  });

  await t.test('2. Critical Test 52: Key A cannot access Tenant B orders or override tenant boundary (INV-10-17)', async () => {
    // Normal query with Key A returns only Tenant A orders
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const resA = await PublicApiService.getOrders(tx, { rawApiKey: keyA.apiKey });
      assert.strictEqual(resA.version, PUBLIC_API_VERSION);
      assert.strictEqual(resA.count, 1);
      assert.strictEqual(resA.orders[0].customer_name, 'Client Tenant A');
      assert.strictEqual(resA.orders[0].tenant_id, tenantA);
    });

    // Attacker using Key A tries GET /api/v1/orders?tenantId=tenantB
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => PublicApiService.getOrders(tx, {
          rawApiKey: keyA.apiKey,
          query: { tenantId: tenantB }
        }),
        err => {
          assert.strictEqual(err.code, INTEGRATION_ERRORS.FORBIDDEN);
          assert.strictEqual(err.statusCode, 403);
          return true;
        }
      );
    });
  });

  await t.test('3. Revocation takes effect immediately (INV-10-16)', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await tx.update('public_api_keys', keyA.keyId, {
        revoked_at: new Date().toISOString()
      });

      await assert.rejects(
        async () => PublicApiService.authenticateKey(tx, keyA.apiKey, 'orders:read'),
        err => err.code === INTEGRATION_ERRORS.UNAUTHORIZED
      );
    });
  });
});
