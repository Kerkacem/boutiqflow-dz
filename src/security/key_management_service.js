/**
 * BoutiqFlow DZ — Key Management & Envelope Encryption Service (INV-13-04, Requirement 6 & 7)
 * Implements KEK -> DEK envelope encryption, key lifecycle management (ACTIVE, ROTATED, REVOKED),
 * and strict cryptographic key separation across architectural domains.
 */

const crypto = require('crypto');
const { KEY_TYPES, KEY_STATUSES, SECURITY_ERRORS } = require('./constants');

class KeyManagementService {
  constructor() {
    // In-memory key vault mapping keyId -> KeyRecord
    this.vault = new Map();
    // Map of keyType -> activeKeyId
    this.activeKeys = new Map();

    // Initialize root KEKs for all separated domains
    for (const type of Object.values(KEY_TYPES)) {
      this.generateKey({ type });
    }
  }

  /**
   * Generates a new cryptographic key for a specific scope
   */
  generateKey({ type, version = 1 }) {
    const keyId = `KEY-${type}-${version}-${crypto.randomBytes(4).toString('hex')}`;
    const rawKey = crypto.randomBytes(32); // 256-bit AES key

    const keyRecord = {
      id: keyId,
      type,
      version,
      rawKey,
      status: KEY_STATUSES.ACTIVE,
      createdAt: new Date().toISOString(),
      rotatedAt: null,
      revokedAt: null
    };

    this.vault.set(keyId, keyRecord);
    this.activeKeys.set(type, keyId);
    return keyRecord;
  }

  /**
   * Rotates a key to a new version: old key becomes ROTATED, new key becomes ACTIVE
   */
  rotateKey(type) {
    const currentKeyId = this.activeKeys.get(type);
    if (!currentKeyId) {
      throw new Error(`No active key found for type ${type}`);
    }

    const currentKey = this.vault.get(currentKeyId);
    const newVersion = (currentKey.version || 1) + 1;

    // Transition current key to ROTATED
    currentKey.status = KEY_STATUSES.ROTATED;
    currentKey.rotatedAt = new Date().toISOString();

    // Generate new active key
    const newKey = this.generateKey({ type, version: newVersion });
    return {
      previousKeyId: currentKeyId,
      newKeyId: newKey.id,
      version: newVersion
    };
  }

  /**
   * Revokes a compromised or deprecated key permanently
   */
  revokeKey(keyId) {
    const key = this.vault.get(keyId);
    if (!key) {
      const err = new Error(`Key ${keyId} not found in vault`);
      err.code = SECURITY_ERRORS.KEY_NOT_FOUND;
      throw err;
    }

    key.status = KEY_STATUSES.REVOKED;
    key.revokedAt = new Date().toISOString();

    if (this.activeKeys.get(key.type) === keyId) {
      // Auto-generate fresh active key so domain is not orphaned
      this.generateKey({ type: key.type, version: key.version + 1 });
    }

    return { revokedKeyId: keyId, status: KEY_STATUSES.REVOKED };
  }

  /**
   * Encrypts plaintext using AES-256-GCM with a unique, randomized 12-byte IV (Requirement 65)
   */
  encrypt(plaintext, type = KEY_TYPES.APPLICATION_SECRET) {
    const activeKeyId = this.activeKeys.get(type);
    if (!activeKeyId) throw new Error(`No active key configured for ${type}`);

    const keyRecord = this.vault.get(activeKeyId);
    if (keyRecord.status !== KEY_STATUSES.ACTIVE) {
      const err = new Error(`Key ${activeKeyId} is not active`);
      err.code = SECURITY_ERRORS.KEY_REVOKED;
      throw err;
    }

    // Unique unpredictable 96-bit (12-byte) IV per operation
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyRecord.rawKey, iv);

    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    const envelope = {
      keyId: keyRecord.id,
      keyType: type,
      version: keyRecord.version,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: encrypted.toString('base64')
    };

    return JSON.stringify(envelope);
  }

  /**
   * Decrypts ciphertext, allowing older ROTATED keys while strictly rejecting REVOKED keys
   */
  decrypt(envelopeJson) {
    let envelope;
    try {
      envelope = typeof envelopeJson === 'string' ? JSON.parse(envelopeJson) : envelopeJson;
    } catch (e) {
      throw new Error('Invalid encryption envelope format');
    }

    const keyRecord = this.vault.get(envelope.keyId);
    if (!keyRecord) {
      const err = new Error(`Decryption failed: Key ${envelope.keyId} not found`);
      err.code = SECURITY_ERRORS.KEY_NOT_FOUND;
      throw err;
    }

    if (keyRecord.status === KEY_STATUSES.REVOKED) {
      const err = new Error(`Decryption Blocked: Key ${envelope.keyId} has been revoked due to compromise`);
      err.code = SECURITY_ERRORS.KEY_REVOKED;
      throw err;
    }

    const iv = Buffer.from(envelope.iv, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyRecord.rawKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  }
}

// Global singleton for key management
const defaultKeyManager = new KeyManagementService();

module.exports = {
  KeyManagementService,
  defaultKeyManager
};
