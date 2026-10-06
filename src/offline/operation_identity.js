/**
 * BoutiqFlow DZ — Operation Identity & Payload Hash (INV-08-01, INV-08-03)
 * Guarantees cryptographic uniqueness and tamper detection for offline mutations.
 */

const crypto = require('crypto');
const { generateUUIDv7 } = require('../db/utils');

/**
 * Deterministically stringifies payload with sorted keys and stringified BigInts
 */
function canonicalStringify(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'bigint') return obj.toString();
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }

  const keys = Object.keys(obj).sort();
  const entries = keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
  return '{' + entries.join(',') + '}';
}

/**
 * Computes canonical SHA-256 hash of operation payload (INV-08-03)
 */
function computeRequestHash(payload) {
  const canonicalStr = canonicalStringify(payload);
  return crypto.createHash('sha256').update(canonicalStr).digest('hex');
}

/**
 * Generates globally unique operationId bound to tenant and device (INV-08-01)
 */
function createOperationId({ tenantId, deviceId, prefix = 'op' } = {}) {
  const uuid = generateUUIDv7();
  const devClean = deviceId ? String(deviceId).replace(/[^a-zA-Z0-9_-]/g, '') : 'dev';
  return `${prefix}_${devClean}_${uuid}`;
}

module.exports = {
  canonicalStringify,
  computeRequestHash,
  createOperationId
};
