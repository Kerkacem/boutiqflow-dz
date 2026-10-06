const { dinarToCentimes } = require('../db/utils');
const { generateInternalEan13 } = require('./barcodes');

/**
 * Robust CSV / Tabular Bulk Catalog Importer for BoutiqFlow DZ
 * Validates:
 * - Duplicate SKUs (within CSV and against DB)
 * - Duplicate Barcodes (within CSV and against DB)
 * - Missing name or selling price
 * - Negative or invalid cost/sale prices
 * - Decimal numbers properly converted to BigInt centimes
 * - Unicode Arabic and French product titles (e.g. Robe d'été)
 * - Atomic all-or-nothing rollback on validation failure
 */

function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    // In standard CSV (RFC 4180), only double quotes are escape delimiters
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

/**
 * Stage 1: Parse and Validate CSV Data against schema (Synchronous)
 * Supports both signatures:
 * - validateCatalogImport(csvContent, options)
 * - validateCatalogImport(tx, csvContent, options)
 */
function validateCatalogImport(csvOrTx, maybeCsv, options = {}) {
  let csvContent;
  let opts = options;

  if (typeof csvOrTx === 'string') {
    csvContent = csvOrTx;
    opts = maybeCsv || {};
  } else {
    csvContent = maybeCsv;
    opts = options || {};
  }

  if (!csvContent || typeof csvContent !== 'string') {
    return { valid: false, errors: [{ row: 0, field: 'file', reason: 'CSV content is empty' }] };
  }

  const lines = csvContent.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) {
    return { valid: false, errors: [{ row: 0, field: 'file', reason: 'CSV must contain a header row and at least one data row' }] };
  }

  const header = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/[\s_\-]/g, ''));
  const colIndex = {
    name: header.indexOf('name'),
    category: header.indexOf('category'),
    brand: header.indexOf('brand'),
    sku: header.indexOf('sku'),
    size: header.indexOf('size'),
    color: header.indexOf('color'),
    cost: header.indexOf('cost') !== -1 ? header.indexOf('cost') : header.indexOf('costprice'),
    price: header.indexOf('price') !== -1 ? header.indexOf('price') : header.indexOf('saleprice'),
    barcode: header.indexOf('barcode')
  };

  if (colIndex.name === -1 || colIndex.sku === -1) {
    return {
      valid: false,
      errors: [{ row: 1, field: 'header', reason: 'Missing required columns: name, sku' }]
    };
  }

  const errors = [];
  const preview = [];
  const seenSkusInFile = new Set();
  const seenBarcodesInFile = new Set();
  const existingDbSkus = opts.existingDbSkus || new Set();
  const existingDbBarcodes = opts.existingDbBarcodes || new Set();

  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1;
    const cols = parseCSVLine(lines[i]);

    // Skip empty lines
    if (cols.every(c => !c)) continue;

    const name = cols[colIndex.name] || '';
    const sku = (cols[colIndex.sku] || '').trim().toUpperCase();
    const category = colIndex.category !== -1 ? (cols[colIndex.category] || 'Général') : 'Général';
    const brand = colIndex.brand !== -1 ? (cols[colIndex.brand] || '') : '';
    const size = colIndex.size !== -1 ? (cols[colIndex.size] || 'UNIQUE') : 'UNIQUE';
    const color = colIndex.color !== -1 ? (cols[colIndex.color] || 'UNIQUE') : 'UNIQUE';
    const rawCost = colIndex.cost !== -1 ? cols[colIndex.cost] : '0';
    const rawPrice = colIndex.price !== -1 ? cols[colIndex.price] : '';
    let barcode = colIndex.barcode !== -1 ? (cols[colIndex.barcode] || '').trim() : '';

    // Row-level validations
    if (!name || name.trim().length === 0) {
      errors.push({ row: rowNum, field: 'name', reason: 'Product name cannot be empty' });
    }

    if (!sku) {
      errors.push({ row: rowNum, field: 'sku', reason: 'SKU cannot be empty' });
    } else if (seenSkusInFile.has(sku)) {
      errors.push({ row: rowNum, field: 'sku', reason: `Duplicate SKU '${sku}' found in import file` });
    } else if (existingDbSkus.has(sku)) {
      errors.push({ row: rowNum, field: 'sku', reason: `SKU '${sku}' already exists in boutique catalog (INV-P02-01)` });
    } else {
      seenSkusInFile.add(sku);
    }

    // Selling price is mandatory
    if (!rawPrice || rawPrice.trim().length === 0) {
      errors.push({ row: rowNum, field: 'price', reason: 'Selling price is mandatory' });
    } else {
      try {
        const priceCentimes = dinarToCentimes(rawPrice);
        if (priceCentimes < 0n) {
          errors.push({ row: rowNum, field: 'price', reason: 'Sale price cannot be negative' });
        }
      } catch {
        errors.push({ row: rowNum, field: 'price', reason: `Invalid sale price: '${rawPrice}'` });
      }
    }

    // Cost price validation
    try {
      const costCentimes = dinarToCentimes(rawCost || '0');
      if (costCentimes < 0n) {
        errors.push({ row: rowNum, field: 'cost', reason: 'Cost price cannot be negative' });
      }
    } catch {
      errors.push({ row: rowNum, field: 'cost', reason: `Invalid cost price format: '${rawCost}'` });
    }

    // Barcode validation & uniqueness
    if (barcode) {
      if (seenBarcodesInFile.has(barcode)) {
        errors.push({ row: rowNum, field: 'barcode', reason: `Duplicate Barcode '${barcode}' found in import file` });
      } else if (existingDbBarcodes.has(barcode)) {
        errors.push({ row: rowNum, field: 'barcode', reason: `Barcode '${barcode}' already exists in boutique catalog (INV-P02-02)` });
      } else {
        seenBarcodesInFile.add(barcode);
      }
    } else {
      // Auto-assign internal EAN-13 if not supplied
      barcode = generateInternalEan13(existingDbBarcodes.size + i);
    }

    if (errors.length === 0 || errors[errors.length - 1].row !== rowNum) {
      let costCentimes = 0n;
      let priceCentimes = 0n;
      try { costCentimes = dinarToCentimes(rawCost || '0'); } catch {}
      try { priceCentimes = dinarToCentimes(rawPrice || '0'); } catch {}

      preview.push({
        row: rowNum,
        name: name.trim(),
        category: category.trim(),
        brand: brand.trim(),
        sku,
        size: size.trim(),
        color: color.trim(),
        cost_price: costCentimes,
        sale_price: priceCentimes,
        barcode
      });
    }
  }

  return {
    valid: errors.length === 0,
    totalRows: lines.length - 1,
    validRowsCount: preview.length,
    errors,
    preview
  };
}

/**
 * Stage 2: Transactional Atomic Commit
 * Commits products and variants into tenant scope.
 * Zero inventory movements are generated (Catalog Domain is strictly decoupled from Inventory Domain).
 */
async function commitCatalogImport(tx, validatedData) {
  if (!validatedData.valid || validatedData.errors.length > 0) {
    throw new Error(`Cannot commit invalid import: ${validatedData.errors.length} validation errors present`);
  }

  const productsByName = new Map();
  const createdVariants = [];

  for (const item of validatedData.preview) {
    // Check or create parent product template
    let product = productsByName.get(item.name);
    if (!product) {
      // Check if product with same name already exists in database
      const existingProds = await tx.query('products', p => p.name === item.name);
      if (existingProds.length > 0) {
        product = existingProds[0];
      } else {
        product = await tx.insert('products', {
          name: item.name,
          category: item.category,
          brand: item.brand,
          is_active: true
        });
      }
      productsByName.set(item.name, product);
    }

    // Insert variant (stock-bearing entity)
    const variant = await tx.insert('product_variants', {
      product_id: product.id,
      sku: item.sku,
      barcode: item.barcode,
      size: item.size,
      color: item.color,
      cost_price_centimes: item.cost_price,
      selling_price_centimes: item.sale_price,
      is_active: true
    });
    createdVariants.push(variant);
  }

  return {
    success: true,
    productsCreated: productsByName.size,
    variantsCreated: createdVariants.length
  };
}

module.exports = {
  parseCSVLine,
  validateCatalogImport,
  commitCatalogImport
};
