/**
 * BoutiqFlow DZ — Delivery Provider Credentials Security
 * AES-256-GCM Encryption at Rest & Secret Masking (INV-07-07)
 */

const crypto = require('crypto');

const DEFAULT_SECRET_KEY = process.env.BOUTIQFLOW_DELIVERY_KEY ||
  crypto.createHash('sha256').update('boutiqflow-dz-delivery-master-key-salt-2026').digest();

function getKey(customKey) {
  if (!customKey) return DEFAULT_SECRET_KEY;
  if (Buffer.isBuffer(customKey) && customKey.length === 32) return customKey;
  return crypto.createHash('sha256').update(String(customKey)).digest();
}

/**
 * Encrypts provider credentials dictionary at rest
 */
function encryptCredentials(credentials, customKey = null) {
  if (!credentials || typeof credentials !== 'object') {
    throw new Error('Invalid credentials object for encryption');
  }

  const key = getKey(customKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const serialized = JSON.stringify(credentials);
  let encrypted = cipher.update(serialized, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    tag
  };
}

/**
 * Decrypts provider credentials dictionary
 */
function decryptCredentials(payload, customKey = null) {
  if (!payload || !payload.ciphertext || !payload.iv || !payload.tag) {
    throw new Error('Invalid encrypted credentials payload');
  }

  const key = getKey(customKey);
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}

/**
 * Masks sensitive API keys, tokens, and passwords for safe logging and client view (INV-07-07)
 */
function maskSecretString(str) {
  if (!str || typeof str !== 'string') return '***';
  if (str.length <= 6) return '***';
  return str.slice(0, 3) + '***' + str.slice(-2);
}

function maskCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object') return {};
  const masked = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (typeof value === 'string') {
      if (/token|key|secret|password|auth/i.test(key)) {
        masked[key] = maskSecretString(value);
      } else {
        masked[key] = value;
      }
    } else {
      masked[key] = '***';
    }
  }
  return masked;
}

module.exports = {
  encryptCredentials,
  decryptCredentials,
  maskCredentials,
  maskSecretString
};
