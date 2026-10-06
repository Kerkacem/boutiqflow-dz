const crypto = require('crypto');

/**
 * UUIDv7 implementation conforming to RFC 9562
 * Millisecond timestamp in the high 48 bits, version 7, variant 2.
 */
function generateUUIDv7(timestampMs = Date.now()) {
  const bytes = crypto.randomBytes(16);

  // 48-bit timestamp
  bytes.writeUIntBE(Math.floor(timestampMs / 0x100000000), 0, 2);
  bytes.writeUInt32BE(timestampMs >>> 0, 2);

  // Version 7: set bits 48-51 to 0111
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Variant 2 (RFC 4122/9562): set bits 64-65 to 10
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32)
  ].join('-');
}

/**
 * Money utilities:
 * All monetary amounts are stored as integer centimes (1 DZD = 100 centimes).
 * Zero floating-point calculations permitted.
 */
function dinarToCentimes(dinar) {
  if (typeof dinar === 'string') {
    dinar = Number(dinar.trim());
  }
  if (!Number.isFinite(dinar)) {
    throw new TypeError('Invalid dinar amount: must be finite number or numeric string');
  }
  return BigInt(Math.round(dinar * 100));
}

function centimesToDinar(centimes) {
  const c = BigInt(centimes);
  const negative = c < 0n;
  const abs = negative ? -c : c;
  const whole = abs / 100n;
  const fraction = abs % 100n;
  const str = `${whole}.${fraction.toString().padStart(2, '0')}`;
  return negative ? `-${str}` : str;
}

function formatDinar(centimes, locale = 'ar-DZ') {
  const c = BigInt(centimes);
  const dinars = Number(c / 100n);
  if (locale.startsWith('ar')) {
    return `${dinars.toLocaleString('ar-DZ')} دج`;
  }
  return `${dinars.toLocaleString('fr-DZ')} DA`;
}

/**
 * Phone normalization for Algeria (E.164 format: +213XXXXXXXXX)
 * Supports inputs like: 0550123456, 0660123456, 0770123456, +213550123456, 213550123456
 */
function normalizeAlgerianPhone(input) {
  if (!input || typeof input !== 'string') return null;
  const cleaned = input.replace(/[\s\-\.\(\)]/g, '');

  if (/^\+213[567][0-9]{8}$/.test(cleaned)) {
    return cleaned;
  }
  if (/^00213[567][0-9]{8}$/.test(cleaned)) {
    return `+${cleaned.substring(2)}`;
  }
  if (/^213[567][0-9]{8}$/.test(cleaned)) {
    return `+${cleaned}`;
  }
  if (/^0[567][0-9]{8}$/.test(cleaned)) {
    return `+213${cleaned.substring(1)}`;
  }
  return null;
}

module.exports = {
  generateUUIDv7,
  dinarToCentimes,
  centimesToDinar,
  formatDinar,
  normalizeAlgerianPhone
};
