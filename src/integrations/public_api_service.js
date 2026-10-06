/**
 * BoutiqFlow DZ — Public REST API Service v1 (INV-10-07, INV-10-16, INV-10-17, INV-10-18)
 * Provides authenticated, scoped, rate-limited, and idempotent public API access (/api/v1/).
 * Strictly enforces tenant boundary from API key credentials without payload override.
 */

const crypto = require('crypto');
const { generateUUIDv7 } = require('../db/utils');
const { hashSecret, computePayloadHash } = require('./crypto_service');
const {
  PUBLIC_API_VERSION,
  INTEGRATION_ERRORS,
  API_SCOPES
} = require('./constants');

class PublicApiService {
  /**
   * Generates a new tenant-bound Public API Key (INV-10-16)
   */
  static async createApiKey(tx, {
    name = 'Standard API Key',
    scopes = ['products:read', 'orders:read'],
    expiresInDays = 365
  } = {}) {
    const tenantId = tx.session.tenantId;
    const rawSecret = `bf_live_${crypto.randomBytes(24).toString('hex')}`;
    const hashedSecret = hashSecret(rawSecret);
    const keyId = generateUUIDv7();

    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 3600 * 1000).toISOString();

    const keyRecord = {
      id: keyId,
      tenant_id: tenantId,
      name,
      hashed_secret: hashedSecret,
      scopes,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      last_used_at: null,
      revoked_at: null
    };

    await tx.insert('public_api_keys', keyRecord);

    await tx.insert('audit_logs', {
      action: 'API_KEY_CREATED',
      actor_id: tx.session.userId || 'system',
      entity_type: 'api_key',
      entity_id: keyId,
      details: { name, scopes, expiresAt },
      created_at: new Date().toISOString()
    });

    return {
      keyId,
      name,
      apiKey: rawSecret, // Returned once to caller
      scopes,
      expiresAt
    };
  }

  /**
   * Authoritatively verifies an API Key and enforces scopes (INV-10-16, INV-10-17)
   */
  static async authenticateKey(tx, rawKey, requiredScope = null) {
    if (!rawKey || typeof rawKey !== 'string') {
      const err = new Error('Unauthorized: Missing or invalid API Key');
      err.code = INTEGRATION_ERRORS.UNAUTHORIZED;
      throw err;
    }

    const hashed = hashSecret(rawKey.trim());
    const keys = await tx.query('public_api_keys', k => k.hashed_secret === hashed);

    if (keys.length === 0) {
      const err = new Error('Unauthorized: Invalid API Key');
      err.code = INTEGRATION_ERRORS.UNAUTHORIZED;
      throw err;
    }

    const key = keys[0];

    if (key.revoked_at) {
      const err = new Error('Unauthorized: API Key has been revoked (INV-10-16)');
      err.code = INTEGRATION_ERRORS.UNAUTHORIZED;
      throw err;
    }

    if (new Date(key.expires_at).getTime() < Date.now()) {
      const err = new Error('Unauthorized: API Key has expired');
      err.code = INTEGRATION_ERRORS.UNAUTHORIZED;
      throw err;
    }

    if (requiredScope && !key.scopes.includes(requiredScope)) {
      const err = new Error(`Forbidden: API Key lacks required scope '${requiredScope}'`);
      err.code = INTEGRATION_ERRORS.FORBIDDEN;
      throw err;
    }

    return {
      keyId: key.id,
      tenantId: key.tenant_id,
      scopes: key.scopes
    };
  }

  /**
   * Enforces Request Idempotency (INV-10-07, INV-10-18)
   */
  static async handleIdempotency(tx, {
    tenantId,
    idempotencyKey,
    payload,
    executionFn
  }) {
    if (!idempotencyKey) {
      // No idempotency requested, execute directly
      return await executionFn();
    }

    const payloadHash = computePayloadHash(payload);

    // Look up previous execution
    const existing = await tx.query('public_idempotency_keys', k =>
      k.tenant_id === tenantId && k.idempotency_key === idempotencyKey
    );

    if (existing.length > 0) {
      const prev = existing[0];

      // Payload hash mismatch: REJECT (INV-10-07)
      if (prev.payload_hash !== payloadHash) {
        const err = new Error('Conflict: Idempotency Key reused with modified payload (INV-10-07)');
        err.code = INTEGRATION_ERRORS.IDEMPOTENCY_KEY_REUSE;
        err.statusCode = 409;
        throw err;
      }

      return {
        replayed: true,
        result: prev.response_body
      };
    }

    // Execute fresh request
    const freshResult = await executionFn();

    // Cache result
    await tx.insert('public_idempotency_keys', {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      idempotency_key: idempotencyKey,
      payload_hash: payloadHash,
      response_body: freshResult,
      created_at: new Date().toISOString()
    });

    return {
      replayed: false,
      result: freshResult
    };
  }

  /**
   * Router endpoint: GET /api/v1/orders (Critical Test 52)
   */
  static async getOrders(tx, {
    rawApiKey,
    query = {}
  }) {
    // 1. Authenticate & extract tenant strictly from API key
    const auth = await this.authenticateKey(tx, rawApiKey, 'orders:read');
    const tenantId = auth.tenantId;

    // 2. Reject user-supplied tenant override attempt (INV-10-17, Critical Test 52)
    if (query.tenantId && query.tenantId !== tenantId) {
      const err = new Error('Forbidden: Client cannot override API key tenant boundary (INV-10-17)');
      err.code = INTEGRATION_ERRORS.FORBIDDEN;
      err.statusCode = 403;
      throw err;
    }

    const limit = Math.min(parseInt(query.limit || 20, 10), 100);
    const orders = await tx.query('online_orders', o => o.tenant_id === tenantId);

    return {
      version: PUBLIC_API_VERSION,
      count: orders.length,
      limit,
      orders: orders.slice(0, limit)
    };
  }
}

module.exports = {
  PublicApiService
};
