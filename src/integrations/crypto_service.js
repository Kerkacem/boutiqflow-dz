/**
 * BoutiqFlow DZ — Integration Cryptography & Secret Management (INV-10-15, INV-10-16, INV-10-19)
 * Encrypts provider credentials at rest with AES-256-GCM, verifies HMAC signatures,
 * and securely hashes API secrets.
 */

const crypto = require('crypto');

const DEFAULT_SECRET_KEY = process.env.BOUTIQFLOW_INTEGRATION_KEY ||
  crypto.createHash('sha256').update('boutiqflow-dz-integration-master-key-salt-2026').digest();

function getKey(customKey) {
  if (!customKey) return DEFAULT_SECRET_KEY;
  if (Buffer.isBuffer(customKey) && customKey.length === 32) return customKey;
  return crypto.createHash('sha256').update(String(customKey)).digest();
}

/**
 * Encrypts integration credentials dictionary at rest
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
 * Decrypts integration credentials dictionary
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
 * Hashes an API key secret or token with SHA-256
 */
function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

/**
 * Computes HMAC-SHA256 signature
 */
function signHmacSha256(payload, secret, encoding = 'base64') {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest(encoding);
}

/**
 * Constant-time verification of HMAC-SHA256 signature
 */
function verifyHmacSha256(payload, signature, secret, encoding = 'base64') {
  if (!signature || !secret) return false;
  try {
    const expected = signHmacSha256(payload, secret, encoding);
    const bufA = Buffer.from(signature, encoding);
    const bufB = Buffer.from(expected, encoding);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Computes deterministic SHA-256 hash of payload
 */
function computePayloadHash(payload) {
  const json = JSON.stringify(payload, (key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted, k) => {
        sorted[k] = value[k];
        return sorted;
      }, {});
    }
    return value;
  });
  return crypto.createHash('sha256').update(json).digest('hex');
}

module.exports = {
  encryptCredentials,
  decryptCredentials,
  hashSecret,
  signHmacSha256,
  verifyHmacSha256,
  computePayloadHash
};
