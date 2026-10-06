const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { CatalogService, normalizeBarcodeInput, normalizeSku } = require('../src/catalog/catalog_service');
const { validateCatalogImport, commitCatalogImport } = require('../src/catalog/importer');
const { ROLES } = require('../src/rbac/permissions');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase 02 — Comprehensive Catalog & Variant Invariants (INV-P02-01 to INV-P02-10)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let productAId;
  let variantA1Id;

  await t.test('Setup initial tenant catalog items', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const prod = await CatalogService.createProduct(tx, {
        name: 'T-Shirt Basic Algérie',
        category: 'T-Shirts',
        brand: 'BoutiqFlow Apparel'
      });
      productAId = prod.id;

      const v1 = await CatalogService.createVariant(tx, {
        productId: productAId,
        sku: 'TS-ALG-BLK-M',
        barcode: '2000000001000',
        size: 'M',
        color: 'Noir',
        costPriceCentimes: 120000n, // 1,200 DA
        sellingPriceCentimes: 250000n // 2,500 DA
      });
      variantA1Id = v1.id;
    });
  });

  await t.test('INV-P02-01: SKU unique per tenant & duplicate rejection', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => {
          await CatalogService.createVariant(tx, {
            productId: productAId,
            sku: 'TS-ALG-BLK-M', // Duplicate SKU
            barcode: '2000000001001',
            sellingPriceCentimes: 250000n
          });
        },
        (err) => err.code === 'DUPLICATE_SKU' && err.statusCode === 409
      );
    });

    // Same SKU in Tenant B is completely valid (tenant isolation)
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const prodB = await CatalogService.createProduct(tx, { name: 'T-Shirt Tenant B' });
      const varB = await CatalogService.createVariant(tx, {
        productId: prodB.id,
        sku: 'TS-ALG-BLK-M', // Same SKU in Tenant B allowed
        barcode: '2000000001000', // Same Barcode in Tenant B allowed
        sellingPriceCentimes: 280000n
      });
      assert.strictEqual(varB.sku, 'TS-ALG-BLK-M');
    });
  });

  await t.test('INV-P02-02: Barcode unique per tenant & duplicate rejection', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => {
          await CatalogService.createVariant(tx, {
            productId: productAId,
            sku: 'TS-ALG-BLK-L',
            barcode: '2000000001000', // Duplicate Barcode in Tenant A
            sellingPriceCentimes: 250000n
          });
        },
        (err) => err.code === 'DUPLICATE_BARCODE' && err.statusCode === 409
      );
    });
  });

  await t.test('INV-P02-03: Variant belongs to exactly one Product & requires productId', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        async () => {
          await CatalogService.createVariant(tx, {
            productId: null,
            sku: 'ORPHAN-SKU-01',
            sellingPriceCentimes: 200000n
          });
        },
        /Variant must be attached to a productId/
      );
    });
  });

  await t.test('INV-P02-04: Variant cannot reference another tenant\'s Product', async () => {
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      await assert.rejects(
        async () => {
          await CatalogService.createVariant(tx, {
            productId: productAId, // Belongs to Tenant A
            sku: 'CROSS-TENANT-SKU-01',
            sellingPriceCentimes: 200000n
          });
        },
        /does not exist in current tenant/
      );
    });
  });

  await t.test('INV-P02-05 & INV-P02-06: Product archive cascades to variants without silent deletion', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const prodToArchive = await CatalogService.createProduct(tx, { name: 'Collection Hiver 2024' });
      const v = await CatalogService.createVariant(tx, {
        productId: prodToArchive.id,
        sku: 'HIV-24-COAT-XL',
        barcode: '2000000009999',
        sellingPriceCentimes: 800000n
      });

      assert.strictEqual(v.is_active, true);

      // Archive product
      const res = await CatalogService.archiveProduct(tx, prodToArchive.id);
      assert.strictEqual(res.archived, true);
      assert.strictEqual(res.archivedVariantsCount, 1);

      // Product and Variant still exist in database, but marked inactive
      const archivedProd = await CatalogService.getProduct(tx, prodToArchive.id);
      const archivedVar = await CatalogService.getVariant(tx, v.id);

      assert.strictEqual(archivedProd.is_active, false);
      assert.strictEqual(archivedVar.is_active, false);
    });
  });

  await t.test('INV-P02-07: Cashier cannot modify protected price or cost fields', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 1. Cashier cannot view cost
      const cashierView = await CatalogService.getVariant(tx, variantA1Id, { userRole: ROLES.CASHIER });
      assert.strictEqual(cashierView.cost_price_centimes, undefined, 'Cost price must be stripped for cashier');
      assert.strictEqual(cashierView.selling_price_centimes, 250000n);

      // 2. Cashier cannot change selling price
      await assert.rejects(
        async () => {
          await CatalogService.updateVariant(tx, variantA1Id, { sellingPriceCentimes: 100000n }, { userRole: ROLES.CASHIER });
        },
        /Access Denied: Cashier cannot modify protected price or cost fields/
      );

      // 3. Cashier cannot create variant
      await assert.rejects(
        async () => {
          await CatalogService.createVariant(tx, {
            productId: productAId,
            sku: 'CASHIER-HACK-SKU',
            sellingPriceCentimes: 200000n,
            userRole: ROLES.CASHIER
          });
        },
        /Access Denied: Cashier cannot set cost prices or create variants/
      );
    });
  });

  await t.test('INV-P02-09: Product/Variant deletion preserves historical transaction integrity', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Simulate historical sale reference on variantA1Id
      await tx.insert('sale_items', {
        variant_id: variantA1Id,
        qty: 1,
        unit_price_centimes: 250000n,
        cost_price_centimes: 120000n,
        total_centimes: 250000n
      });

      // Attempting to delete variant fails with 409 conflict
      await assert.rejects(
        async () => {
          await CatalogService.deleteVariant(tx, variantA1Id);
        },
        (err) => err.code === 'HISTORICAL_DATA_RESTRICTION' && err.statusCode === 409
      );

      // Attempting to delete parent product fails as well
      await assert.rejects(
        async () => {
          await CatalogService.deleteProduct(tx, productAId);
        },
        (err) => err.code === 'HISTORICAL_DATA_RESTRICTION' && err.statusCode === 409
      );
    });
  });

  await t.test('INV-P02-10: Every catalog mutation is auditable', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Update price as Owner
      await CatalogService.updateVariant(tx, variantA1Id, { sellingPriceCentimes: 270000n });

      const auditEntries = await tx.query('audit_logs', a => a.action === 'price:change');
      assert.ok(auditEntries.length >= 1);
      assert.ok(auditEntries[0].metadata.includes('270000'));
    });
  });

  await t.test('Barcode Scanner input normalization and lookup', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Scanner sends with trailing carriage return and whitespace: "2000000001000\r\n"
      const scannedInput = '  2000000001000\r\n';
      const variant = await CatalogService.getVariantByBarcode(tx, scannedInput);

      assert.ok(variant);
      assert.strictEqual(variant.sku, 'TS-ALG-BLK-M');
      assert.strictEqual(variant.barcode, '2000000001000');
    });
  });

  await t.test('Bulk CSV Import: Arabic and French Names, decimals, and validations', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const csv = `name,category,brand,sku,size,color,cost,price,barcode
عباية فراشة سوداء مطرزة,عبايات,Tradition DZ,ABY-FRSH-BLK-U,UNIQUE,Noir,4500.50,8900.00,2000000002001
Robe d'été fleurie en soie,Robes,Mode Paris,ROB-SOIE-RED-38,38,Rouge,3200,6400.75,2000000002002
Chemise Lin Slim,Chemises,Elegance,CHM-LIN-WHT-L,L,Blanc,2100.25,4200.50,2000000002003
`;

      const validation = validateCatalogImport(csv);
      assert.strictEqual(validation.valid, true);
      assert.strictEqual(validation.validRowsCount, 3);

      // Verify decimal conversions to BigInt centimes
      assert.strictEqual(validation.preview[0].cost_price, 450050n); // 4500.50 DA = 450050 centimes
      assert.strictEqual(validation.preview[0].sale_price, 890000n);
      assert.strictEqual(validation.preview[1].sale_price, 640075n);

      const commitRes = await commitCatalogImport(tx, validation);
      assert.strictEqual(commitRes.success, true);
      assert.strictEqual(commitRes.variantsCreated, 3);

      // Lookup by Arabic name
      const arabicVariants = await tx.query('product_variants', v => v.sku === 'ABY-FRSH-BLK-U');
      assert.strictEqual(arabicVariants.length, 1);
      assert.strictEqual(arabicVariants[0].cost_price_centimes, 450050n);
    });
  });

  await t.test('Bulk CSV Import: Error detection and zero-row rollback atomicity', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const initialVariantCount = (await tx.query('product_variants')).length;

      // Corrupted CSV: duplicate SKU in file, negative price, missing name, missing price, duplicate DB sku
      const badCsv = `name,category,brand,sku,size,color,cost,price,barcode
,Robes,Brand,BAD-01,M,Noir,1000,2000,2000000003001
Bon Produit,Robes,Brand,,M,Noir,1000,2000,2000000003002
Produit Prix Negatif,Robes,Brand,BAD-03,M,Noir,-500,2000,2000000003003
Produit Sans Prix Vente,Robes,Brand,BAD-04,M,Noir,1000,,2000000003004
Produit SKU Existant,Robes,Brand,TS-ALG-BLK-M,M,Noir,1000,2000,2000000003005
`;

      const existingVariants = await tx.query('product_variants');
      const existingDbSkus = new Set(existingVariants.map(v => v.sku));
      const validation = validateCatalogImport(badCsv, { existingDbSkus });
      assert.strictEqual(validation.valid, false);
      assert.ok(validation.errors.length >= 5);

      // Attempting commit throws error
      await assert.rejects(
        async () => {
          await commitCatalogImport(tx, validation);
        },
        /Cannot commit invalid import/
      );

      // ATOMICITY: Exactly 0 rows were added
      const finalVariantCount = (await tx.query('product_variants')).length;
      assert.strictEqual(finalVariantCount, initialVariantCount, 'Failed import must commit ZERO rows');
    });
  });
});
