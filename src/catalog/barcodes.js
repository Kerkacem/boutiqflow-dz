/**
 * Barcode Engine for MAHAL
 * Implements internal EAN-13 (Prefix 20-29 restricted-circulation range)
 * and Code128 identification standards.
 */

/**
 * Calculates EAN-13 Check Digit using standard Modulo-10 algorithm.
 * Input: 12-digit string
 * Output: Check digit (0-9)
 */
function calculateEan13CheckDigit(twelveDigits) {
  if (!/^\d{12}$/.test(twelveDigits)) {
    throw new Error('EAN-13 calculation requires exactly 12 numeric digits');
  }

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(twelveDigits[i], 10);
    // 0-indexed: index 0 (1st digit) weight 1, index 1 (2nd digit) weight 3, etc.
    sum += (i % 2 === 0) ? digit * 1 : digit * 3;
  }

  const remainder = sum % 10;
  return (remainder === 0) ? 0 : 10 - remainder;
}

/**
 * Validates whether a 13-digit string is a mathematically valid EAN-13 barcode.
 */
function isValidEan13(barcode) {
  if (!/^\d{13}$/.test(barcode)) return false;
  const payload = barcode.substring(0, 12);
  const checkDigit = parseInt(barcode[12], 10);
  return calculateEan13CheckDigit(payload) === checkDigit;
}

/**
 * Generates an internal EAN-13 barcode.
 * Uses the restricted circulation prefix (20 to 29) to avoid colliding with GS1 global products.
 * @param {number} prefix - Must be between 20 and 29 (default 20)
 * @param {number|string} itemSequence - Unique sequence or number within the store (1 to 999999999)
 */
function generateInternalEan13(itemSequence, prefix = 20) {
  if (prefix < 20 || prefix > 29) {
    throw new Error('Internal EAN-13 prefix must be between 20 and 29 (restricted circulation range)');
  }

  const prefixStr = prefix.toString().padStart(2, '0');
  const seqStr = itemSequence.toString().padStart(10, '0');

  if (seqStr.length > 10) {
    throw new Error('Item sequence exceeds 10 digits for internal EAN-13');
  }

  const twelveDigits = `${prefixStr}${seqStr}`;
  const checkDigit = calculateEan13CheckDigit(twelveDigits);
  return `${twelveDigits}${checkDigit}`;
}

/**
 * Code128 Barcode generation and validator
 * Accepts alphanumeric characters, hyphens, and underscores.
 */
function isValidCode128(code) {
  if (!code || typeof code !== 'string') return false;
  // Code128 Character Set B handles ASCII 32 to 126
  return /^[\x20-\x7E]{3,48}$/.test(code);
}

function generateCode128(prefix, sequence) {
  const cleanPrefix = (prefix || 'MHL').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cleanSeq = sequence.toString().padStart(6, '0');
  return `${cleanPrefix}-${cleanSeq}`;
}

module.exports = {
  calculateEan13CheckDigit,
  isValidEan13,
  generateInternalEan13,
  isValidCode128,
  generateCode128
};
