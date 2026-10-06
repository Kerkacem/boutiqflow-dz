const { generateInternalEan13 } = require('./barcodes');
const { dinarToCentimes } = require('../db/utils');

/**
 * Clothing Variant Matrix Generator for MAHAL
 */

const SIZE_TEMPLATES = {
  LETTER: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'],
  NUMERIC: ['36', '38', '40', '42', '44', '46', '48'],
  KIDS: ['1A', '2A', '3A', '4A', '6A', '8A', '10A', '12A', '14A']
};

/**
 * Creates SKU slug from string (uppercase, alphanumeric and hyphens preserved)
 */
function toSkuPart(str) {
  return str
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\-]/g, '');
}

/**
 * Generates Cartesian product matrix of variants
 * @param {Object} product
 * @param {string} product.name - Product Name
 * @param {string} product.baseSku - Root SKU prefix
 * @param {number|string|bigint} product.costPrice - Cost price in DA or centimes
 * @param {number|string|bigint} product.salePrice - Sale price in DA or centimes
 * @param {Object} options
 * @param {string[]} options.sizes - List of sizes
 * @param {string[]} options.colors - List of colors
 * @param {number} [startBarcodeSequence=1] - Starting counter for EAN-13 barcodes
 */
function generateVariantMatrix(product, options, startBarcodeSequence = 1) {
  if (!product || !product.baseSku) {
    throw new Error('Base SKU is required to generate variant matrix');
  }

  const sizes = (options.sizes && options.sizes.length > 0) ? options.sizes : ['UNIQUE'];
  const colors = (options.colors && options.colors.length > 0) ? options.colors : ['UNIQUE'];

  const baseSku = toSkuPart(product.baseSku);
  const costCentimes = typeof product.costPrice === 'bigint'
    ? product.costPrice
    : dinarToCentimes(product.costPrice || 0);

  const saleCentimes = typeof product.salePrice === 'bigint'
    ? product.salePrice
    : dinarToCentimes(product.salePrice || 0);

  const variants = [];
  let seq = startBarcodeSequence;

  for (const color of colors) {
    for (const size of sizes) {
      const colorPart = color === 'UNIQUE' ? '' : `-${toSkuPart(color)}`;
      const sizePart = size === 'UNIQUE' ? '' : `-${toSkuPart(size)}`;
      const sku = `${baseSku}${colorPart}${sizePart}`;
      const barcode = generateInternalEan13(seq);
      seq++;

      variants.push({
        sku,
        barcode,
        size,
        color,
        cost_price: costCentimes,
        sale_price: saleCentimes
      });
    }
  }

  return {
    baseSku,
    totalVariants: variants.length,
    variants,
    nextBarcodeSequence: seq
  };
}

module.exports = {
  SIZE_TEMPLATES,
  generateVariantMatrix
};
