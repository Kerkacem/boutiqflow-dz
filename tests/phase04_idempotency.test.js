const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  openRegisterSession,
  processSale,
  processRefund,
  TENDER_TYPES
} = require('../src/pos/register');
const { receiveStock, getVariantStock, getStockLedger } = require('../src/inventory/ledger');
const { ROLES } = require('../src/rbac/permissions');

test('Phase 04 — POS Idempotency & Replay Protection Suite (INV-04-08)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let locationId, cashierId, managerId, sessionId, variantId;

  await t.test('Setup tenant, session, and initial stock', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Alger Idempotency' });
      locationId = loc.id;

      const cashier = await tx.insert('users', { name: 'Cashier User', role: 'cashier', email: 'cashier@idemp.dz' });
      cashierId = cashier.id;

      const manager = await tx.insert('users', { name: 'Manager User', role: 'manager', email: 'manager@idemp.dz' });
      managerId = manager.id;

      const prod = await tx.insert('products', { name: 'Blazer Élégant' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'BLZ-ELG-BLK-48',
        size: '48',
        color: 'Noir',
        cost_price: 450000n,
        sale_price: 950000n // 9,500 DA
      });
      variantId = variant.id;

      await receiveStock(tx, { variantId, locationId, quantity: 20 });
      const session = await openRegisterSession(tx, { locationId, cashierId, openingCashCentimes: 1000000n });
      sessionId = session.id;
    });
  });

  await t.test('INV-04-08: Sequential duplicate sale submission (10x same operationId)', async () => {
    const fixedOperationId = `POS-OP-REPLAY-${generateUUIDv7()}`;
    const responses = [];

    // Simulate cashier double-clicking or terminal auto-retry 10 times
    for (let i = 0; i < 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await processSale(tx, {
          sessionId,
          locationId,
          cashierId,
          items: [{ variantId, qty: 1 }],
          payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 950000n }],
          operationId: fixedOperationId,
          notes: `Attempt ${i}`
        });
        responses.push(res);
      });
    }

    // 1. All 10 responses have identical saleId and receiptNumber
    assert.strictEqual(responses.length, 10);
    const primarySaleId = responses[0].saleId;
    const primaryReceipt = responses[0].receiptNumber;

    for (let i = 1; i < 10; i++) {
      assert.strictEqual(responses[i].saleId, primarySaleId);
      assert.strictEqual(responses[i].receiptNumber, primaryReceipt);
      assert.strictEqual(responses[i].replayed, true, 'Subsequent attempts must return replayed flag');
    }

    // 2. Exactly ONE sale record in database
    await db.withTenant({ tenantId }, async (tx) => {
      const sales = await tx.query('sales', s => s.operation_id === fixedOperationId);
      assert.strictEqual(sales.length, 1, 'Exactly 1 sale row created in database');

      // 3. Exactly ONE inventory deduction (20 - 1 = 19, NOT 20 - 10 = 10)
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 19, 'Stock must only be deducted ONCE (19 units)');

      // 4. Exactly ONE cash drawer transaction (+9,500 DA, NOT +95,000 DA)
      const cashTxs = await tx.query('cash_transactions', ct => ct.reference_id === primarySaleId);
      assert.strictEqual(cashTxs.length, 1);
      assert.strictEqual(cashTxs[0].amount_centimes, 950000n);

      // 5. Exactly ONE payment record
      const payments = await tx.query('sale_payments', p => p.sale_id === primarySaleId);
      assert.strictEqual(payments.length, 1);
    });
  });

  await t.test('INV-04-08: Sequential duplicate refund submission (10x same operationId)', async () => {
    let saleId, saleItemId;
    await db.withTenant({ tenantId }, async (tx) => {
      const sale = await processSale(tx, {
        sessionId,
        locationId,
        cashierId,
        items: [{ variantId, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 950000n }]
      });
      saleId = sale.saleId;
      saleItemId = (await tx.query('sale_items', i => i.sale_id === saleId))[0].id;
    });

    const fixedRefundOpId = `REFUND-OP-REPLAY-${generateUUIDv7()}`;
    const refundResponses = [];

    // Simulate 10 duplicate refund attempts
    for (let i = 0; i < 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await processRefund(tx, {
          saleId,
          sessionId,
          cashierId: managerId,
          itemsToRefund: [{ saleItemId, qty: 1 }],
          operationId: fixedRefundOpId,
          actorRole: ROLES.MANAGER
        });
        refundResponses.push(res);
      });
    }

    assert.strictEqual(refundResponses.length, 10);
    const primaryRefundId = refundResponses[0].refundId;
    for (let i = 1; i < 10; i++) {
      assert.strictEqual(refundResponses[i].refundId, primaryRefundId);
      assert.strictEqual(refundResponses[i].replayed, true);
    }

    // Exactly 1 refund master row in database
    await db.withTenant({ tenantId }, async (tx) => {
      const refunds = await tx.query('refunds', r => r.operation_id === fixedRefundOpId);
      assert.strictEqual(refunds.length, 1);

      // Stock restocked only once
      const stock = await getVariantStock(tx, variantId, locationId);
      assert.strictEqual(stock.onHand, 19); // 18 + 1
    });
  });

  await t.test('INV-04-08: Concurrent rapid sale submission with identical operationId', async () => {
    const concurrentOpId = `CONCURRENT-OP-${generateUUIDv7()}`;

    // Firing 10 simultaneous requests
    const attempts = Array.from({ length: 10 }, () => {
      return db.withTenant({ tenantId }, async (tx) => {
        return await processSale(tx, {
          sessionId,
          locationId,
          cashierId,
          items: [{ variantId, qty: 1 }],
          payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 950000n }],
          operationId: concurrentOpId
        });
      });
    });

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    assert.strictEqual(fulfilled.length, 10, 'All 10 concurrent requests resolve successfully');

    const firstId = fulfilled[0].value.saleId;
    for (const res of fulfilled) {
      assert.strictEqual(res.value.saleId, firstId);
    }

    await db.withTenant({ tenantId }, async (tx) => {
      const matchingSales = await tx.query('sales', s => s.operation_id === concurrentOpId);
      assert.strictEqual(matchingSales.length, 1, 'Exactly ONE sale created under concurrent duplicate pressure');
    });
  });
});
