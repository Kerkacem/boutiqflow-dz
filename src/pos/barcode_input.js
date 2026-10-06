/**
 * Barcode & Scanner Input Processing Engine for BoutiqFlow DZ
 * Handles keyboard-wedge barcode scanner streams, EAN-13, SKU lookups,
 * and Arabic numeral digit normalizations.
 */

const ARABIC_INDIC_DIGITS = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
};

const PERSIAN_DIGITS = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
};

class BarcodeInputService {
  /**
   * Normalizes scanner or keyboard input:
   * 1. Strips carriage returns, line feeds, tabs (Enter suffix from scanner)
   * 2. Replaces Arabic-Indic and Persian numeral digits with standard Latin digits
   * 3. Trims external whitespace
   */
  static normalizeInput(raw) {
    if (raw === null || raw === undefined) return '';
    let str = String(raw).trim();

    // Strip carriage return and line feed (standard scanner suffix)
    str = str.replace(/[\r\n\t]/g, '');

    // Convert Arabic-Indic and Persian digits
    let normalized = '';
    for (const char of str) {
      if (ARABIC_INDIC_DIGITS[char] !== undefined) {
        normalized += ARABIC_INDIC_DIGITS[char];
      } else if (PERSIAN_DIGITS[char] !== undefined) {
        normalized += PERSIAN_DIGITS[char];
      } else {
        normalized += char;
      }
    }

    return normalized.trim();
  }

  /**
   * Looks up a product variant in current tenant by Barcode or SKU
   */
  static async lookupItem(tx, rawInput) {
    const normalized = this.normalizeInput(rawInput);
    if (!normalized) {
      throw new Error('Barcode Scan Error: Input cannot be empty');
    }

    // 1. Direct barcode match
    const byBarcode = await tx.query('product_variants', v => v.barcode === normalized);
    if (byBarcode.length > 0) {
      const variant = byBarcode[0];
      const product = await tx.findById('products', variant.product_id);
      if (!product || product.is_active === false) {
        throw new Error(`Catalog Error: Product '${product ? product.name : variant.product_id}' is archived`);
      }
      return { variant, product, matchedBy: 'BARCODE' };
    }

    // 2. Direct SKU match (case-insensitive)
    const bySku = await tx.query('product_variants', v => v.sku && v.sku.toLowerCase() === normalized.toLowerCase());
    if (bySku.length > 0) {
      const variant = bySku[0];
      const product = await tx.findById('products', variant.product_id);
      if (!product || product.is_active === false) {
        throw new Error(`Catalog Error: Product '${product ? product.name : variant.product_id}' is archived`);
      }
      return { variant, product, matchedBy: 'SKU' };
    }

    return null;
  }

  /**
   * Processes a simulated scanner event stream with timestamp deltas
   */
  static processScanStream(streamBuffer, { interKeyTimeoutMs = 50 } = {}) {
    if (!streamBuffer) return { valid: false, raw: '', normalized: '' };

    const raw = String(streamBuffer);
    const normalized = this.normalizeInput(raw);

    return {
      valid: normalized.length >= 3,
      raw,
      normalized,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = {
  BarcodeInputService
};
