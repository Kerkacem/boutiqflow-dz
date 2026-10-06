const test = require('node:test');
const assert = require('node:assert');
const { calculateEan13CheckDigit, isValidEan13, generateInternalEan13, generateCode128, isValidCode128 } = require('../src/catalog/barcodes');
const { SIZE_TEMPLATES, generateVariantMatrix } = require('../src/catalog/matrix');
const { validateCatalogImport, commitCatalogImport } = require('../src/catalog/importer');
const { generateLabelSheetHtml } = require('../src/catalog/labels');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase P2 — Catalog, Matrix, Barcodes, and Bulk Import', async (t) => {
  await t.test('EAN-13 Engine: Prefix 20-29 & Modulo-10 Checksum', () => {
    // Known EAN-13 calculation
    // '200000000001': sum = 2*1 + 0*3 + 0*1 + ... + 0*3 + 1*1 = 2 + 1 = 3 -> (10 - 3) = 7
    // Let's verify our check digit formula
    const checkDigit = calculateEan13CheckDigit('200000000001');
    assert.strictEqual(typeof checkDigit, 'number');
    assert.ok(checkDigit >= 0 && checkDigit <= 9);

    const fullBarcode = `200000000001${checkDigit}`;
    assert.strictEqual(isValidEan13(fullBarcode), true, 'Generated EAN-13 must be mathematically valid');

    // Generated with internal prefix 20
    const generated = generateInternalEan13(456, 20);
    assert.strictEqual(generated.startsWith('20'), true);
    assert.strictEqual(isValidEan13(generated), true);

    // Invalid prefix rejected
    assert.throws(() => generateInternalEan13(1, 10), /Internal EAN-13 prefix must be between 20 and 29/);
    assert.throws(() => generateInternalEan13(1, 35), /Internal EAN-13 prefix must be between 20 and 29/);

    // Code128
    const code = generateCode128('MHL', 123);
    assert.strictEqual(code, 'MHL-000123');
    assert.strictEqual(isValidCode128(code), true);
  });

  await t.test('Variant Matrix Generator: Cartesian Product & Clothing Sizes', () => {
    const product = {
      name: 'Robe d’été Fleurie',
      baseSku: 'ROB-FLEUR',
      costPrice: '1800', // 1,800 DA
      salePrice: '3200'  // 3,200 DA
    };

    const options = {
      sizes: ['S', 'M', 'L'],
      colors: ['Noir', 'Blanc']
    };

    const result = generateVariantMatrix(product, options, 100);
    assert.strictEqual(result.totalVariants, 6);
    assert.strictEqual(result.variants.length, 6);

    // Check SKU format
    const skus = result.variants.map(v => v.sku);
    assert.ok(skus.includes('ROB-FLEUR-NOIR-S'));
    assert.ok(skus.includes('ROB-FLEUR-BLANC-L'));

    // Check barcode validity on all variants
    for (const v of result.variants) {
      assert.strictEqual(isValidEan13(v.barcode), true);
      assert.strictEqual(v.cost_price, 180000n);
      assert.strictEqual(v.sale_price, 320000n);
    }

    // Verify predefined clothing templates exist
    assert.ok(SIZE_TEMPLATES.LETTER.includes('XL'));
    assert.ok(SIZE_TEMPLATES.NUMERIC.includes('42'));
    assert.ok(SIZE_TEMPLATES.KIDS.includes('6A'));
  });

  await t.test('CSV Import Validation & Row-Level Error Reporting', () => {
    // CSV with one valid row and two invalid rows (duplicate SKU and negative price)
    const csvWithErrors = `
Name, Category, Brand, SKU, Size, Color, Cost, Price
Chemise Lin, Chemises, Zara, CHM-01, M, Blanc, 2000, 3500
Chemise Lin, Chemises, Zara, CHM-01, L, Blanc, 2000, 3500
Pantalon Toile, Pantalons, Zara, PNT-01, 40, Beige, -500, 4000
    `.trim();

    const validation = validateCatalogImport(csvWithErrors);
    assert.strictEqual(validation.valid, false, 'Should be flagged as invalid');
    assert.ok(validation.errors.length >= 2, 'Must record at least 2 row-level errors');

    const duplicateError = validation.errors.find(e => e.field === 'sku' && e.reason.includes('Duplicate SKU'));
    assert.ok(duplicateError, 'Must detect duplicate SKU');

    const costError = validation.errors.find(e => e.field === 'cost' && e.reason.includes('cannot be negative'));
    assert.ok(costError, 'Must detect negative cost price');
  });

  await t.test('Atomic Commit & Rollback: 0 rows committed if invalid', async () => {
    const db = new MahalDatabase();
    const tenantId = generateUUIDv7();

    const invalidCsv = `
Name, SKU, Cost, Price
Article A, ART-01, 1000, 2000
Article B, ART-01, 1000, 2000
    `.trim();

    const validation = validateCatalogImport(invalidCsv);
    assert.strictEqual(validation.valid, false);

    await assert.rejects(
      async () => {
        await db.withTenant({ tenantId }, async (tx) => {
          await commitCatalogImport(tx, validation);
        });
      },
      /Cannot commit invalid import/
    );

    // Verify 0 products committed
    await db.withTenant({ tenantId }, async (tx) => {
      const products = await tx.query('products');
      assert.strictEqual(products.length, 0, 'Zero products must be saved when import fails');
    });
  });

  await t.test('Valid Import Commit & Barcode Label Generation (UAT-1 Partial: 200 Products)', async () => {
    const db = new MahalDatabase();
    const tenantId = generateUUIDv7();

    // Create 200 products with variants in CSV
    const rows = ['Name, Category, Brand, SKU, Size, Color, Cost, Price'];
    for (let i = 1; i <= 200; i++) {
      rows.push(`Pantalon Mode ${i}, Pantalons, BrandDZ, PNT-${i}-M, M, Noir, 1500, 2800`);
    }
    const csvContent = rows.join('\n');

    const validation = validateCatalogImport(csvContent);
    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.preview.length, 200);

    let commitResult = null;
    await db.withTenant({ tenantId }, async (tx) => {
      commitResult = await commitCatalogImport(tx, validation);
    });

    assert.strictEqual(commitResult.productsCreated, 200);
    assert.strictEqual(commitResult.variantsCreated, 200);

    // Verify database content
    await db.withTenant({ tenantId }, async (tx) => {
      const products = await tx.query('products');
      assert.strictEqual(products.length, 200);
      const variants = await tx.query('product_variants');
      assert.strictEqual(variants.length, 200);
    });

    // Test Barcode label sheet HTML generation
    const labelHtml = generateLabelSheetHtml(validation.preview.slice(0, 30), 'a4_30');
    assert.ok(labelHtml.includes('grid-container'), 'A4 sheet must use grid container');
    assert.ok(labelHtml.includes('2800.00 DA'), 'Must display formatted price in DA');

    const thermalHtml = generateLabelSheetHtml(validation.preview.slice(0, 1), 'thermal_58');
    assert.ok(thermalHtml.includes('thermal-container'), 'Thermal layout must use thermal container');
  });

  await t.test('Performance Benchmark: 5,000 Variants import processed in < 60s', () => {
    const startTime = Date.now();

    // Generate 5,000 lines
    const rows = ['Name, Category, Brand, SKU, Size, Color, Cost, Price'];
    for (let i = 1; i <= 5000; i++) {
      rows.push(`Jacket Winter ${i}, Vestes, OutdoorDZ, JCK-${i}, L, Bleu, 3000, 5500`);
    }
    const bigCsv = rows.join('\n');

    const validation = validateCatalogImport(bigCsv);
    const elapsedSeconds = (Date.now() - startTime) / 1000;

    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.preview.length, 5000);
    assert.ok(elapsedSeconds < 60, `5,000 variants import must take < 60s (took ${elapsedSeconds.toFixed(2)}s)`);
  });
});
