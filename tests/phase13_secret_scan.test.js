const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  KeyManagementService,
  KEY_TYPES,
  KEY_STATUSES,
  SECURITY_ERRORS
} = require('../src/security');

test('Phase 13 — Secret Scanning, Key Separation & Rotation (INV-13-04, Requirements 5, 6, 7)', async (t) => {
  await t.test('1. Cryptographic Key Separation across domains (Requirement 7)', () => {
    const kms = new KeyManagementService();
    const appKey = kms.activeKeys.get(KEY_TYPES.APPLICATION_SECRET);
    const backupKey = kms.activeKeys.get(KEY_TYPES.BACKUP_ENCRYPTION);
    const webhookKey = kms.activeKeys.get(KEY_TYPES.WEBHOOK_SIGNING);

    assert.ok(appKey);
    assert.ok(backupKey);
    assert.ok(webhookKey);

    // Each domain must use distinct key IDs and distinct material
    assert.notStrictEqual(appKey, backupKey);
    assert.notStrictEqual(appKey, webhookKey);
    assert.notStrictEqual(backupKey, webhookKey);
  });

  await t.test('2. Key Rotation without loss of decryptability for older data (Requirement 6)', () => {
    const kms = new KeyManagementService();
    const secretMessage = 'Customer Credit Ledger Secret 2026';

    // 1. Encrypt with version 1
    const ciphertext1 = kms.encrypt(secretMessage, KEY_TYPES.APPLICATION_SECRET);

    // 2. Rotate key to version 2
    const rotateRes = kms.rotateKey(KEY_TYPES.APPLICATION_SECRET);
    assert.strictEqual(rotateRes.version, 2);

    // 3. Encrypt new message with version 2
    const ciphertext2 = kms.encrypt('New Version Data', KEY_TYPES.APPLICATION_SECRET);

    // 4. Verify BOTH ciphertexts can still be decrypted correctly
    assert.strictEqual(kms.decrypt(ciphertext1), secretMessage);
    assert.strictEqual(kms.decrypt(ciphertext2), 'New Version Data');
  });

  await t.test('3. Revoked key strictly blocks decryption of associated data (Requirement 6)', () => {
    const kms = new KeyManagementService();
    const sensitiveData = 'High-risk payload';
    const ciphertext = kms.encrypt(sensitiveData, KEY_TYPES.CREDENTIAL_ENCRYPTION);

    const parsedEnvelope = JSON.parse(ciphertext);
    const usedKeyId = parsedEnvelope.keyId;

    // Revoke the key
    kms.revokeKey(usedKeyId);

    // Subsequent decryption attempt must be strictly blocked
    assert.throws(
      () => kms.decrypt(ciphertext),
      (err) => {
        assert.strictEqual(err.code, SECURITY_ERRORS.KEY_REVOKED);
        return true;
      }
    );
  });

  await t.test('4. Automated Secret Scan across source code (Requirement 5)', () => {
    const patterns = [
      /sk_live_[0-9a-zA-Z]{24}/,
      /ghp_[0-9a-zA-Z]{36}/,
      /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
      /AIza[0-9A-Za-z-_]{35}/
    ];

    const srcDir = path.join(__dirname, '..', 'src');
    const files = fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.js'))
      .map(d => path.join(d.path || d.parentPath, d.name));

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        assert.strictEqual(pattern.test(content), false, `Secret leak pattern detected in ${file}`);
      }
    }
  });
});
