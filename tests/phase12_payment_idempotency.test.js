const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  InvoiceService,
  PaymentService,
  BILLING_ERRORS
} = require('../src/billing');

test('Phase 12 — Payment Idempotency & Tamper Protection (INV-12-08, Requirement 27)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Same idempotency key + same payload yields identical response without duplicate records (INV-12-08)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const inv = await InvoiceService.createInvoice(tx, {
        planVersionId: 'STARTER_V1',
        lines: [{ description: 'Starter Plan', unitPriceCents: 149000n, quantity: 1 }]
      });
      const invoiceId = inv.invoice.id;
      const idempotencyKey = 'IDEM-PAY-TEST-001';

      // First call
      const res1 = await PaymentService.createPaymentAttempt(tx, {
        invoiceId,
        amountCents: 149000n,
        currency: 'DZD',
        paymentMethod: 'EDAHABIA_CIB',
        idempotencyKey
      });
      assert.strictEqual(res1.replayed, false);
      assert.ok(res1.attempt.id);

      // Replay identical call
      const res2 = await PaymentService.createPaymentAttempt(tx, {
        invoiceId,
        amountCents: 149000n,
        currency: 'DZD',
        paymentMethod: 'EDAHABIA_CIB',
        idempotencyKey
      });
      assert.strictEqual(res2.replayed, true);
      assert.strictEqual(res2.attempt.id, res1.attempt.id);

      // Verify only 1 attempt in database
      const attempts = await tx.query('payment_attempts', a => a.idempotency_key === idempotencyKey);
      assert.strictEqual(attempts.length, 1);
    });
  });

  await t.test('2. Same idempotency key with different payload is rejected with conflict (INV-12-08)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const inv = await InvoiceService.createInvoice(tx, {
        planVersionId: 'STARTER_V1',
        lines: [{ description: 'Starter Plan', unitPriceCents: 149000n, quantity: 1 }]
      });
      const invoiceId = inv.invoice.id;
      const idempotencyKey = 'IDEM-PAY-CONFLICT-001';

      // Original call with 149000n
      await PaymentService.createPaymentAttempt(tx, {
        invoiceId,
        amountCents: 149000n,
        currency: 'DZD',
        idempotencyKey
      });

      // Second call with different amount 299000n -> conflict
      await assert.rejects(
        async () => PaymentService.createPaymentAttempt(tx, {
          invoiceId,
          amountCents: 299000n,
          currency: 'DZD',
          idempotencyKey
        }),
        (err) => {
          assert.strictEqual(err.code, BILLING_ERRORS.IDEMPOTENCY_PAYLOAD_MISMATCH);
          return true;
        }
      );
    });
  });
});
