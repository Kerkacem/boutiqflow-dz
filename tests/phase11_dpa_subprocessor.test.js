const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  SubprocessorService
} = require('../src/compliance');

test('Phase 11 — Subprocessor Inventory & DPA Version Tracking (INV-11-22, INV-11-23)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Registers subprocessors with purpose, data categories, and location (INV-11-22)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const sp1 = await SubprocessorService.registerSubprocessor(tx, {
        name: 'Yalidine Express Logistics',
        purpose: 'Courier delivery and COD cash collection across 58 wilayas',
        dataCategories: ['CUSTOMER_NAME', 'PHONE', 'ADDRESS'],
        location: 'ALGERIA',
        contractStatus: 'EXECUTED'
      });

      const sp2 = await SubprocessorService.registerSubprocessor(tx, {
        name: 'Algerian SMS Gateway SPA',
        purpose: 'Transactional SMS notifications for OTP and COD order confirmations',
        dataCategories: ['PHONE_NUMBER'],
        location: 'ALGERIA'
      });

      assert.ok(sp1.id);
      assert.ok(sp2.id);

      const list = await SubprocessorService.listSubprocessors(tx);
      assert.strictEqual(list.length, 2);
    });
  });

  await t.test('2. DPA records track version and status without automatic legal presumption (INV-11-23)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // DPA record starts in UNDER_REVIEW by default
      const dpa = await SubprocessorService.createDpaRecord(tx, {
        controller: 'Boutique Mode Alger SARL',
        processor: 'BoutiqFlow DZ Technologies EURL',
        version: '2026.1',
        subprocessors: ['Yalidine Express Logistics', 'Algerian SMS Gateway SPA'],
        securityAnnex: 'SECURITY_ANNEX_V1'
      });

      assert.ok(dpa.id);
      assert.strictEqual(dpa.status, 'UNDER_REVIEW');
      assert.strictEqual(dpa.version, '2026.1');

      // Update after legal team signature
      const approvedDpa = await SubprocessorService.updateDpaStatus(tx, dpa.id, {
        status: 'APPROVED',
        reviewedBy: 'legal_counsel_karim'
      });

      assert.strictEqual(approvedDpa.status, 'APPROVED');
      assert.strictEqual(approvedDpa.reviewed_by, 'legal_counsel_karim');
    });
  });
});
