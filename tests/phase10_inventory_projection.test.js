const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { applyStockMovement, MOVEMENT_REASONS, getVariantStock } = require('../src/inventory/ledger');
const {
  IntegrationService,
  InventoryProjectionService,
  PROVIDERS,
  INTEGRATION_ERRORS
} = require('../src/integrations');

test('Phase 10 — Critical Inventory Projection & Stale Event Protection (INV-10-02, INV-10-10, Critical Test 50)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let locationId = null;
  let variantId = null;
  let integrationId = null;

  await t.test('Setup: Seed 10 units in BoutiqFlow, map to Shopify external inventory item', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Dépôt Central', type: 'warehouse' });
      locationId = loc.id;

      const prod = await tx.insert('products', { name: 'Veste Cuir', category: 'Hommes' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'VST-CUIR-L',
        barcode: '6139998887771',
        selling_price_cents: 1500000n
      });
      variantId = variant.id;

      // Seed 10 units into ledger with OPENING_BALANCE
      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: loc.id,
        quantity: 10,
        reason: MOVEMENT_REASONS.OPENING_BALANCE
      });

      const itg = await IntegrationService.registerIntegration(tx, {
        provider: PROVIDERS.SHOPIFY,
        name: 'Shopify Store',
        credentials: {
          shopDomain: 'cuir-boutique.myshopify.com',
          accessToken: 'shpat_cuir_token'
        },
        scopes: ['read_orders', 'read_products', 'read_inventory']
      });
      integrationId = itg.id;

      // Create variant mapping
      await tx.insert('integration_mappings', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        integration_id: integrationId,
        local_type: 'VARIANT',
        local_id: variantId,
        external_type: 'INVENTORY_ITEM',
        external_id: 'gid://shopify/InventoryItem/888999',
        last_synced_at: new Date(Date.now() - 60000).toISOString()
      });
    });

    await db.withTenant({ tenantId }, async (tx) => {
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.available, 10);
    });
  });

  await t.test('1. BoutiqFlow sells 2 units -> Local available = 8 -> Project to Shopify = 8', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Sale of 2 units
      await applyStockMovement(tx, {
        variantId,
        locationId,
        quantity: -2,
        reason: MOVEMENT_REASONS.POS_SALE
      });

      // Project stock to Shopify
      const proj = await InventoryProjectionService.projectVariantStock(tx, {
        integrationId,
        variantId,
        locationId
      });

      assert.strictEqual(proj.success, true);
      assert.strictEqual(proj.availableQuantity, 8);
      assert.strictEqual(proj.projectionResult.projectedQuantity, 8);

      const currentStock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(currentStock.available, 8);
    });
  });

  await t.test('2. Stale External Event: Shopify webhook arrives reporting old quantity 10 -> REJECTED (INV-10-10)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const res = await InventoryProjectionService.handleExternalInventoryEvent(tx, {
        integrationId,
        externalVariantId: 'gid://shopify/InventoryItem/888999',
        incomingQuantity: 10, // Stale old stock
        eventTimestamp: new Date(Date.now() - 120000).toISOString() // 2 minutes ago (before sync)
      });

      assert.strictEqual(res.handled, true);
      assert.strictEqual(res.isStale, true);
      assert.strictEqual(res.status, INTEGRATION_ERRORS.STALE_EXTERNAL_EVENT);

      // Verify BoutiqFlow local inventory was NEVER overwritten blindly
      const currentStock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(currentStock.available, 8, 'Local stock must strictly remain authoritative at 8 units (INV-10-02)');
    });
  });
});
