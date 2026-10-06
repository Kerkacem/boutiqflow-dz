const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  createSupplier,
  createPurchaseOrder,
  receiveGoods,
  returnGoodsToSupplier
} = require('../src/procurement/procurement_service');
const {
  getSupplierBalance,
  recordSupplierPayment
} = require('../src/procurement/payables_service');
const {
  recordExpense,
  generatePnLReport,
  EXPENSE_CATEGORIES
} = require('../src/finance/finance');

test('Phase 05 — Financial Idempotency & Replay Protection Suite (INV-05-08)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let supplierId = null;
  let locationId = null;
  let variantId = null;

  await t.test('Setup tenant, location, supplier, and catalog variant', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Main Depot', type: 'warehouse' });
      locationId = loc.id;

      const sup = await createSupplier(tx, { name: 'Grossiste Chaussures', phone: '0555001122' });
      supplierId = sup.id;

      const prod = await tx.insert('products', { name: 'Chaussure Cuir' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'CHS-CUIR-BRN-42',
        size: '42',
        color: 'Marron',
        cost_price: 300000n, // 3,000 DA
        sale_price: 600000n
      });
      variantId = v.id;
    });
  });

  await t.test('INV-05-08: Sequential duplicate goods receiving (10x same operationId)', async () => {
    let poId = null;
    let lineId = null;

    await db.withTenant({ tenantId }, async (tx) => {
      const po = await createPurchaseOrder(tx, {
        supplierId,
        locationId,
        lines: [{ variantId, orderedQty: 50, unitCostCentimes: 300000n }]
      });
      poId = po.id;
      lineId = po.lines[0].id;
    });

    const receiptOpId = `RECEIPT-OP-${Date.now()}`;
    const results = [];

    // Submit the exact same goods receipt request 10 times consecutively
    for (let i = 1; i <= 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await receiveGoods(tx, {
          purchaseOrderId: poId,
          locationId,
          receivedLines: [{ purchaseLineId: lineId, receivedQty: 20 }],
          operationId: receiptOpId
        });
        results.push(res);
      });
    }

    assert.strictEqual(results.length, 10);
    assert.strictEqual(results[0].replayed, false, 'First request was freshly processed');
    for (let i = 1; i < 10; i++) {
      assert.strictEqual(results[i].replayed, true, `Request ${i + 1} was detected as duplicate replay`);
      assert.strictEqual(results[i].receipt.id, results[0].receipt.id, 'Returns identical receipt ID');
    }

    // Verify invariants:
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Exactly 1 receipt in database
      const receipts = await tx.query('purchase_receipts', r => r.purchase_order_id === poId);
      assert.strictEqual(receipts.length, 1, 'INV-05-08: Exactly 1 purchase receipt created');

      // 2. Stock on hand is exactly 20 (NOT 200)
      const stockLevels = await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === locationId);
      assert.strictEqual(stockLevels[0].on_hand, 20, 'INV-05-08: Stock incremented exactly once (20 units)');

      // 3. Exactly 1 stock movement
      const movements = await tx.query('stock_movements', m => m.variant_id === variantId && m.location_id === locationId);
      assert.strictEqual(movements.length, 1, 'INV-05-08: Exactly 1 stock ledger movement recorded');

      // 4. Exactly 1 financial entry
      const finEntries = await tx.query('financial_entries', fe => fe.entry_type === 'PURCHASE_RECEIVED');
      assert.strictEqual(finEntries.length, 1, 'INV-05-08: Exactly 1 financial entry recorded');

      // 5. PO line received_qty is 20
      const poLine = await tx.findById('purchase_lines', lineId);
      assert.strictEqual(poLine.received_qty, 20);
    });
  });

  await t.test('INV-05-08: Sequential duplicate supplier payment (10x same operationId)', async () => {
    const paymentOpId = `PAY-OP-${Date.now()}`;
    const results = [];

    // Current outstanding balance is 20 units * 3,000 DA = 60,000 DA (6,000,000 centimes)
    // Submit payment of 20,000 DA 10 times with the same operationId
    for (let i = 1; i <= 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await recordSupplierPayment(tx, {
          supplierId,
          amountCentimes: 2000000n,
          operationId: paymentOpId
        });
        results.push(res);
      });
    }

    assert.strictEqual(results.length, 10);
    assert.strictEqual(results[0].replayed, false);
    for (let i = 1; i < 10; i++) {
      assert.strictEqual(results[i].replayed, true, `Payment ${i + 1} recognized as duplicate`);
      assert.strictEqual(results[i].payment.id, results[0].payment.id);
    }

    // Verify database state:
    await db.withTenant({ tenantId }, async (tx) => {
      // Exactly 1 payment record
      const payments = await tx.query('supplier_payments', p => p.supplier_id === supplierId);
      assert.strictEqual(payments.length, 1, 'INV-05-08: Exactly 1 payment record inserted');

      // Outstanding balance decremented by 20,000 DA once (from 60,000 to 40,000 DA)
      const balance = await getSupplierBalance(tx, supplierId);
      assert.strictEqual(balance.totalPaidCentimes, 2000000n, 'INV-05-08: Total paid is 20,000 DA');
      assert.strictEqual(balance.outstandingPayableCentimes, 4000000n, 'Outstanding balance is 40,000 DA');
    });
  });

  await t.test('INV-05-08: Sequential duplicate purchase return (10x same operationId)', async () => {
    let poId = null;
    let lineId = null;

    await db.withTenant({ tenantId }, async (tx) => {
      const poList = await tx.query('purchase_orders', p => p.supplier_id === supplierId);
      poId = poList[0].id;
      const lines = await tx.query('purchase_lines', l => l.purchase_order_id === poId);
      lineId = lines[0].id;
    });

    const returnOpId = `RET-OP-${Date.now()}`;
    const results = [];

    // Return 5 units with the same operationId 10 times
    for (let i = 1; i <= 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await returnGoodsToSupplier(tx, {
          purchaseOrderId: poId,
          locationId,
          returnLines: [{ purchaseLineId: lineId, returnedQty: 5 }],
          operationId: returnOpId
        });
        results.push(res);
      });
    }

    assert.strictEqual(results.length, 10);
    assert.strictEqual(results[0].replayed, false);
    for (let i = 1; i < 10; i++) {
      assert.strictEqual(results[i].replayed, true);
      assert.strictEqual(results[i].returnRecord.id, results[0].returnRecord.id);
    }

    // Verify database state:
    await db.withTenant({ tenantId }, async (tx) => {
      // Exactly 1 return record
      const returns = await tx.query('purchase_returns', r => r.purchase_order_id === poId);
      assert.strictEqual(returns.length, 1, 'INV-05-08: Exactly 1 purchase return record');

      // Stock was 20; 5 returned -> stock must be 15 (NOT negative or 0)
      const stockLevels = await tx.query('stock_levels', l => l.variant_id === variantId && l.location_id === locationId);
      assert.strictEqual(stockLevels[0].on_hand, 15, 'INV-05-08: Stock decremented by 5 exactly once');

      // Outstanding payable was 40,000; 5 units * 3,000 = 15,000 returned -> balance is 25,000 DA
      const balance = await getSupplierBalance(tx, supplierId);
      assert.strictEqual(balance.totalReturnedCentimes, 1500000n);
      assert.strictEqual(balance.outstandingPayableCentimes, 2500000n, 'Outstanding balance is 25,000 DA');
    });
  });

  await t.test('INV-05-08: Sequential duplicate operating expense (10x same operationId)', async () => {
    const expenseOpId = `EXP-OP-${Date.now()}`;
    const results = [];

    for (let i = 1; i <= 10; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const res = await recordExpense(tx, {
          categoryId: EXPENSE_CATEGORIES.PACKAGING,
          amountCentimes: 500000n, // 5,000 DA
          description: 'Shopping bags',
          operationId: expenseOpId
        });
        results.push(res);
      });
    }

    assert.strictEqual(results.length, 10);
    for (let i = 1; i < 10; i++) {
      assert.strictEqual(results[i].id, results[0].id);
    }

    await db.withTenant({ tenantId }, async (tx) => {
      const expenses = await tx.query('expenses', e => e.category_id === EXPENSE_CATEGORIES.PACKAGING);
      assert.strictEqual(expenses.length, 1, 'INV-05-08: Exactly 1 expense record inserted');

      const pnl = await generatePnLReport(tx);
      assert.strictEqual(pnl.totalExpenses, 500000n, 'INV-05-08: Operating expenses incremented by 5,000 DA exactly once');
    });
  });
});
