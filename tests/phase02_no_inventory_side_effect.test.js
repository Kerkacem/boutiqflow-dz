const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { CatalogService } = require('../src/catalog/catalog_service');
const { validateCatalogImport, commitCatalogImport } = require('../src/catalog/importer');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase 02 — Absolute Decoupling: Product/Variant CRUD Has Zero Inventory Side Effects (INV-P02-08)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('Creating 1 Product and 10 Variants creates ZERO stock movements, levels, or reservations', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Create Product Template
      const product = await CatalogService.createProduct(tx, {
        name: 'Costume Homme Cérémonie',
        category: 'Costumes',
        brand: 'Prestige DZ'
      });

      // 2. Create 10 Variants (2 colors x 5 sizes)
      const colors = ['Noir', 'Bleu Nuit'];
      const sizes = ['48', '50', '52', '54', '56'];
      let count = 0;

      for (const color of colors) {
        for (const size of sizes) {
          count++;
          await CatalogService.createVariant(tx, {
            productId: product.id,
            sku: `CST-PREST-${color === 'Noir' ? 'BLK' : 'BLU'}-${size}`,
            barcode: `2000000000${count.toString().padStart(3, '0')}`,
            color,
            size,
            costPriceCentimes: 1500000n, // 15,000 DA
            sellingPriceCentimes: 3200000n // 32,000 DA
          });
        }
      }

      assert.strictEqual(count, 10, 'Exactly 10 variants created');

      // 3. STRICT ASSERTION: Inventory Domain remains untouched
      const movements = await tx.query('stock_movements');
      const levels = await tx.query('stock_levels');
      const reservations = await tx.query('stock_reservations');

      assert.strictEqual(movements.length, 0, 'Catalog CRUD must generate ZERO stock movements');
      assert.strictEqual(levels.length, 0, 'Catalog CRUD must generate ZERO stock level records');
      assert.strictEqual(reservations.length, 0, 'Catalog CRUD must generate ZERO reservations');
    });
  });

  await t.test('Bulk CSV Import of 5 products and 15 variants generates ZERO inventory mutations', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const csv = `name,category,brand,sku,size,color,cost,price,barcode
Chemise Oxford,Chemises,Classic,CHM-OXF-WHT-S,S,Blanc,1800,3500,2000000000101
Chemise Oxford,Chemises,Classic,CHM-OXF-WHT-M,M,Blanc,1800,3500,2000000000102
Chemise Oxford,Chemises,Classic,CHM-OXF-WHT-L,L,Blanc,1800,3500,2000000000103
Polo Piqué,Polos,Classic,POL-PIQ-BLK-M,M,Noir,1500,2800,2000000000104
Polo Piqué,Polos,Classic,POL-PIQ-BLK-L,L,Noir,1500,2800,2000000000105
`;

      const validation = await validateCatalogImport(tx, csv);
      assert.strictEqual(validation.valid, true);

      const commitRes = await commitCatalogImport(tx, validation);
      assert.strictEqual(commitRes.success, true);
      assert.strictEqual(commitRes.variantsCreated, 5);

      // Verify ZERO inventory side-effects after bulk commit
      const movements = await tx.query('stock_movements');
      const levels = await tx.query('stock_levels');
      const reservations = await tx.query('stock_reservations');

      assert.strictEqual(movements.length, 0, 'Bulk CSV import must generate ZERO stock movements');
      assert.strictEqual(levels.length, 0, 'Bulk CSV import must generate ZERO stock level records');
      assert.strictEqual(reservations.length, 0, 'Bulk CSV import must generate ZERO reservations');
    });
  });

  await t.test('Variant updates and price changes generate ZERO inventory mutations', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const variants = await tx.query('product_variants');
      assert.ok(variants.length >= 15);

      const firstVariant = variants[0];
      await CatalogService.updateVariant(tx, firstVariant.id, {
        sellingPriceCentimes: 3500000n, // Updated to 35,000 DA
        costPriceCentimes: 1600000n
      });

      // Still ZERO inventory mutations
      const movements = await tx.query('stock_movements');
      const levels = await tx.query('stock_levels');
      assert.strictEqual(movements.length, 0, 'Variant update must never touch inventory');
      assert.strictEqual(levels.length, 0, 'Variant update must never touch inventory');
    });
  });
});
