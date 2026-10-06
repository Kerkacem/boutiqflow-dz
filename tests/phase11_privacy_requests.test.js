const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  PrivacyRequestService,
  PRIVACY_REQUEST_TYPES,
  PRIVACY_REQUEST_STATUSES,
  COMPLIANCE_ERRORS
} = require('../src/compliance');

test('Phase 11 — Data Subject Rights & Financial Immutability (INV-11-11, INV-11-12, Section 64)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let customerId = null;
  let accessRequestId = null;

  await t.test('Setup: Seed customer and customer order', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const cust = await tx.insert('customers', {
        name: 'Nadia Boumediene',
        phone: '0555112233',
        address: '5 Rue Larbi Ben Mhidi, Alger'
      });
      customerId = cust.id;

      await tx.insert('online_orders', {
        customer_id: cust.id,
        customer_name: cust.name,
        customer_phone: cust.phone,
        total_centimes: 1200000n,
        status: 'DELIVERED',
        created_at: new Date().toISOString()
      });
    });
  });

  await t.test('1. Identity Verification Gate: Fulfilling ACCESS before verification is rejected (INV-11-11)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const req = await PrivacyRequestService.createRequest(tx, {
        identifier: '0555112233',
        type: PRIVACY_REQUEST_TYPES.ACCESS
      });
      accessRequestId = req.id;
      assert.strictEqual(req.status, PRIVACY_REQUEST_STATUSES.CREATED);
      assert.strictEqual(req.identity_verified, false);

      // Attempting fulfillment without identity verification is BLOCKED
      await assert.rejects(
        async () => PrivacyRequestService.fulfillRequest(tx, req.id),
        err => {
          assert.strictEqual(err.code, COMPLIANCE_ERRORS.IDENTITY_NOT_VERIFIED);
          return true;
        }
      );
    });
  });

  await t.test('2. Fulfill ACCESS after identity verification yields personal data without internal secrets', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Verify identity
      await PrivacyRequestService.verifyIdentity(tx, accessRequestId, {
        method: 'SMS_OTP',
        evidenceReference: 'OTP-VERIFIED-984712'
      });

      const res = await PrivacyRequestService.fulfillRequest(tx, accessRequestId);
      assert.strictEqual(res.request.status, PRIVACY_REQUEST_STATUSES.FULFILLED);
      assert.strictEqual(res.result.customerProfile.name, 'Nadia Boumediene');
      assert.strictEqual(res.result.ordersCount, 1);
      assert.ok(res.result.excludedInternalSecrets.includes('PASSWORD_HASHES'));
    });
  });

  await t.test('3. RECTIFICATION: Allows profile updates but blocks altering historical financial ledger (INV-11-12)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const rectReq = await PrivacyRequestService.createRequest(tx, {
        identifier: '0555112233',
        type: PRIVACY_REQUEST_TYPES.RECTIFICATION
      });

      await PrivacyRequestService.verifyIdentity(tx, rectReq.id, {
        method: 'ID_CARD_VERIFICATION',
        evidenceReference: 'DOC-VERIFIED-4411'
      });

      // Attempting to rewrite historical financial price/cost under guise of rectification is REJECTED
      await assert.rejects(
        async () => PrivacyRequestService.fulfillRequest(tx, rectReq.id, {
          updates: { historicalSale: true, salePrice: 1000 }
        }),
        err => {
          assert.strictEqual(err.code, COMPLIANCE_ERRORS.FINANCIAL_HISTORY_IMMUTABLE);
          return true;
        }
      );

      // Updating mutable customer address succeeds
      const rectResult = await PrivacyRequestService.fulfillRequest(tx, rectReq.id, {
        updates: { address: 'Nouvelle Adresse, Didouche Mourad' }
      });

      assert.strictEqual(rectResult.result.rectified, true);
      const cust = await tx.findById('customers', customerId);
      assert.strictEqual(cust.address, 'Nouvelle Adresse, Didouche Mourad');
    });
  });
});
