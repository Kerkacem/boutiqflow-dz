const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  TransferGuardService,
  TRANSFER_STATUSES,
  COMPLIANCE_STATUSES,
  COMPLIANCE_ERRORS
} = require('../src/compliance');

test('Phase 11 — International Transfer Guard & Runtime Interceptor (INV-11-18, INV-11-19, Section 63)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Domestic processing in Algeria is inherently permitted without international transfer check', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const check = await TransferGuardService.checkTransferPermitted(tx, {
        destinationCountry: 'ALGERIA'
      });
      assert.strictEqual(check.permitted, true);
      assert.strictEqual(check.status, TRANSFER_STATUSES.LOCAL);
    });
  });

  await t.test('2. Critical Test 63: External transfer with REVIEW_REQUIRED is strictly BLOCKED prior to transmission (INV-11-19)', async () => {
    let transfer = null;

    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Unregistered country throws TRANSFER_BLOCKED immediately
      await assert.rejects(
        async () => TransferGuardService.checkTransferPermitted(tx, { destinationCountry: 'GERMANY' }),
        err => {
          assert.strictEqual(err.code, COMPLIANCE_ERRORS.TRANSFER_BLOCKED);
          return true;
        }
      );

      // 2. Register transfer in REVIEW_REQUIRED status
      transfer = await TransferGuardService.registerTransfer(tx, {
        destinationCountry: 'FRANCE',
        destinationOrganization: 'European Courier Gateway SAS',
        transferStatus: TRANSFER_STATUSES.REVIEW_REQUIRED,
        legalReviewStatus: COMPLIANCE_STATUSES.LEGAL_REVIEW_REQUIRED
      });

      assert.strictEqual(transfer.transfer_status, TRANSFER_STATUSES.REVIEW_REQUIRED);

      // 3. Attempting transmission while REVIEW_REQUIRED must be BLOCKED (INV-11-19)
      await assert.rejects(
        async () => TransferGuardService.checkTransferPermitted(tx, { destinationCountry: 'FRANCE' }),
        err => {
          assert.strictEqual(err.code, COMPLIANCE_ERRORS.TRANSFER_BLOCKED);
          return true;
        }
      );

      // 4. Formally approve transfer following legal review
      await TransferGuardService.approveTransfer(tx, transfer.id, {
        authorizationReference: 'ANPDP_TRANSFER_AUTH_2026_09'
      });

      // 5. Subsequent transmission check succeeds
      const check = await TransferGuardService.checkTransferPermitted(tx, { destinationCountry: 'FRANCE' });
      assert.strictEqual(check.permitted, true);
      assert.strictEqual(check.status, TRANSFER_STATUSES.AUTHORIZED);
    });
  });
});
