const test = require('node:test');
const assert = require('node:assert');
const {
  openRegisterSession,
  generateXReport,
  closeRegisterSession,
  processSale,
  processExchange,
  TENDER_TYPES
} = require('../src/pos/register');
const { OfflineOutbox, syncOfflineOutbox } = require('../src/pos/offline_sync');
const { generateReceiptHtml } = require('../src/pos/receipts');
const { applyStockMovement, createReservation, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase P4 — POS, Cash Register, Offline Outbox & Scenarios', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let locationId = null;
  let cashierId = null;
  let customerId = null;
  let variant1 = null;
  let variant2 = null;
  let variant3 = null;

  await t.test('Setup POS environment: shop location, cashier, customer, and products', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Magasin Alger', type: 'shop' });
      locationId = loc.id;

      const user = await tx.insert('users', { name: 'Amine Cashier', email: 'amine@shop.dz', role: 'cashier', password_hash: 'xxx' });
      cashierId = user.id;

      const cust = await tx.insert('customers', { name: 'Omar Dahmani', phone: '+213550112233', debt_balance_centimes: 0n });
      customerId = cust.id;

      const p1 = await tx.insert('products', { name: 'Pantalon Chino' });
      variant1 = await tx.insert('product_variants', {
        product_id: p1.id,
        sku: 'CHN-BEIGE-40',
        size: '40',
        color: 'Beige',
        cost_price: 150000n, // 1,500 DA
        sale_price: 280000n  // 2,800 DA
      });

      const p2 = await tx.insert('products', { name: 'Polo Piqué' });
      variant2 = await tx.insert('product_variants', {
        product_id: p2.id,
        sku: 'POL-BLANC-M',
        size: 'M',
        color: 'Blanc',
        cost_price: 120000n, // 1,200 DA
        sale_price: 260000n  // 2,600 DA
      });

      const p3 = await tx.insert('products', { name: 'Ceinture Cuir' });
      variant3 = await tx.insert('product_variants', {
        product_id: p3.id,
        sku: 'CEINT-MARRON',
        size: 'UNIQUE',
        color: 'Marron',
        cost_price: 80000n,  // 800 DA
        sale_price: 180000n  // 1,800 DA
      });

      // Seed initial stock
      await applyStockMovement(tx, { variantId: variant1.id, locationId, qty: 10, reason: MOVEMENT_REASONS.RECEIVING });
      await applyStockMovement(tx, { variantId: variant2.id, locationId, qty: 10, reason: MOVEMENT_REASONS.RECEIVING });
      await applyStockMovement(tx, { variantId: variant3.id, locationId, qty: 10, reason: MOVEMENT_REASONS.RECEIVING });
    });
  });

  await t.test('UAT-3: POS sell 3 items with split payment (Cash + Credit), debt recorded, stock decremented', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const session = await openRegisterSession(tx, { locationId, cashierId, openingCashCentimes: 1000000n }); // 10,000 DA opening cash

      // 3 items:
      // variant1: 1 qty @ 2,800 DA (280,000 centimes)
      // variant2: 1 qty @ 2,600 DA (260,000 centimes)
      // variant3: 1 qty @ 1,800 DA (180,000 centimes)
      // Total = 7,200 DA (720,000 centimes)
      // Split payment: 4,000 DA Cash (400,000 centimes) + 3,200 DA Customer Credit (320,000 centimes)
      const sale = await processSale(tx, {
        sessionId: session.id,
        locationId,
        cashierId,
        customerId,
        items: [
          { variantId: variant1.id, qty: 1 },
          { variantId: variant2.id, qty: 1 },
          { variantId: variant3.id, qty: 1 }
        ],
        payments: [
          { tenderType: TENDER_TYPES.CASH, amountCentimes: 400000n },
          { tenderType: TENDER_TYPES.CUSTOMER_CREDIT, amountCentimes: 320000n }
        ],
        idempotencyKey: 'uat3_sale_001'
      });

      assert.strictEqual(sale.total, 720000n, 'Total must equal 7,200 DA');
      assert.strictEqual(sale.creditAmount, 320000n, 'Customer credit tender recorded');

      // Verify customer debt balance updated
      const customer = await tx.findById('customers', customerId);
      assert.strictEqual(customer.debt_balance_centimes, 320000n, 'Customer debt balance must be 3,200 DA');

      // Verify customer ledger debit entry created
      const ledger = await tx.query('customer_ledger', l => l.customer_id === customerId);
      assert.strictEqual(ledger.length, 1);
      assert.strictEqual(ledger[0].amount_centimes, 320000n);
      assert.strictEqual(ledger[0].type, 'SALE_CREDIT');

      // Verify inventory decremented by 1 for each variant
      const level1 = (await tx.query('stock_levels', l => l.variant_id === variant1.id && l.location_id === locationId))[0];
      const level2 = (await tx.query('stock_levels', l => l.variant_id === variant2.id && l.location_id === locationId))[0];
      const level3 = (await tx.query('stock_levels', l => l.variant_id === variant3.id && l.location_id === locationId))[0];

      assert.strictEqual(level1.on_hand, 9, 'Variant 1 stock must be 10 - 1 = 9');
      assert.strictEqual(level2.on_hand, 9, 'Variant 2 stock must be 10 - 1 = 9');
      assert.strictEqual(level3.on_hand, 9, 'Variant 3 stock must be 10 - 1 = 9');

      // Test Receipt Generation
      const receiptHtml = generateReceiptHtml({
        shopName: 'Boutique Karim',
        address: 'Rue Didouche Mourad, Alger',
        phone: '0550112233',
        receiptNumber: sale.receiptNumber,
        cashierName: 'Amine',
        customerName: customer.name,
        items: [
          { name: 'Pantalon Chino', color: 'Beige', size: '40', qty: 1, unitPriceCentimes: 280000n, lineTotalCentimes: 280000n },
          { name: 'Polo Piqué', color: 'Blanc', size: 'M', qty: 1, unitPriceCentimes: 260000n, lineTotalCentimes: 260000n },
          { name: 'Ceinture Cuir', color: 'Marron', size: 'UNIQUE', qty: 1, unitPriceCentimes: 180000n, lineTotalCentimes: 180000n }
        ],
        subtotalCentimes: 720000n,
        totalCentimes: 720000n,
        payments: [
          { tenderType: 'نقداً (Cash)', amountCentimes: 400000n },
          { tenderType: 'كريدي (Crédit)', amountCentimes: 320000n }
        ]
      });

      assert.ok(receiptHtml.includes('Boutique Karim'), 'Must render shop name');
      assert.ok(receiptHtml.includes('7200.00 DA'), 'Must render total amount');
      assert.ok(receiptHtml.includes('Omar Dahmani'), 'Must render customer name on credit receipt');
    });
  });

  await t.test('INV-6: Cost snapshot preserved even if variant cost price changes later', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Find the sale item created in UAT-3
      const saleItems = await tx.query('sale_items', i => i.variant_id === variant1.id);
      assert.strictEqual(saleItems.length, 1);
      assert.strictEqual(saleItems[0].cost_snapshot_centimes, 150000n, 'Cost snapshot must be 1,500 DA at sale time');

      // Now supplier price increases to 2,200 DA
      await tx.update('product_variants', variant1.id, {
        cost_price: 220000n
      });

      // Verify historical sale item still has old cost snapshot (INV-6)
      const historicalItem = await tx.findById('sale_items', saleItems[0].id);
      assert.strictEqual(historicalItem.cost_snapshot_centimes, 150000n, 'INV-6: Historical cost snapshot must never change');
    });
  });

  await t.test('UAT-8: In-Store Size Exchange in One Flow (Size M swapped for Size L, 0 DA net)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Create Size L variant with identical price (2,600 DA)
      const variant2L = await tx.insert('product_variants', {
        product_id: variant2.product_id,
        sku: 'POL-BLANC-L',
        size: 'L',
        color: 'Blanc',
        cost_price: 120000n,
        sale_price: 260000n
      });
      await applyStockMovement(tx, { variantId: variant2L.id, locationId, qty: 5, reason: MOVEMENT_REASONS.RECEIVING });

      const stockBeforeM = (await tx.query('stock_levels', l => l.variant_id === variant2.id && l.location_id === locationId))[0].on_hand;
      const stockBeforeL = (await tx.query('stock_levels', l => l.variant_id === variant2L.id && l.location_id === locationId))[0].on_hand;

      // Exchange 1 unit Size M for 1 unit Size L
      const exchange = await processExchange(tx, {
        locationId,
        cashierId,
        returnedVariantId: variant2.id,
        returnedQty: 1,
        newVariantId: variant2L.id,
        newQty: 1,
        idempotencyKey: 'uat8_exchange_001'
      });

      assert.strictEqual(exchange.total, 0n, 'Zero-differential size exchange has total 0 DA');

      // Stock of returned Size M increments (+1)
      const stockAfterM = (await tx.query('stock_levels', l => l.variant_id === variant2.id && l.location_id === locationId))[0].on_hand;
      assert.strictEqual(stockAfterM, stockBeforeM + 1, 'Returned Size M stock must increment by 1');

      // Stock of new Size L decrements (-1)
      const stockAfterL = (await tx.query('stock_levels', l => l.variant_id === variant2L.id && l.location_id === locationId))[0].on_hand;
      assert.strictEqual(stockAfterL, stockBeforeL - 1, 'New Size L stock must decrement by 1');
    });
  });

  await t.test('UAT-4: Offline PWA Queue, 5 Offline Sales, Reconnection Sync & Idempotency', async () => {
    const outbox = new OfflineOutbox('POS-TERMINAL-01');

    // Simulate offline mode: 5 sales queued locally
    for (let i = 1; i <= 5; i++) {
      outbox.enqueueSale({
        locationId,
        cashierId,
        items: [{ variantId: variant3.id, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 180000n }]
      });
    }

    assert.strictEqual(outbox.getPendingSales().length, 5);

    // Reconnection: sync outbox with server
    let syncResult = null;
    await db.withTenant({ tenantId }, async (tx) => {
      syncResult = await syncOfflineOutbox(tx, outbox);
    });

    assert.strictEqual(syncResult.synchronizedCount, 5, 'All 5 sales synchronized');
    assert.strictEqual(outbox.getPendingSales().length, 0, 'Outbox cleared after successful sync');

    // Verify receipt numbers are strictly sequential: e.g. POS-TERMINAL-01-000001 to 000005
    const receiptNums = syncResult.results.map(r => r.receiptNumber);
    assert.ok(receiptNums.includes('POS-TERMINAL-01-000001'));
    assert.ok(receiptNums.includes('POS-TERMINAL-01-000005'));

    // Replay attack / duplicate sync test: resending the same sales must be idempotent
    await db.withTenant({ tenantId }, async (tx) => {
      const replaySale = await processSale(tx, {
        locationId,
        cashierId,
        items: [{ variantId: variant3.id, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 180000n }],
        idempotencyKey: 'offline_POS-TERMINAL-01_seq_1' // Replay first sale
      });
      assert.strictEqual(replaySale.replayed, true, 'Replayed sale must be detected via idempotency key');
    });
  });

  await t.test('UAT-5: Concurrency Race Condition (Shop POS vs Online Order for Last Unit)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Create exclusive item with exactly 1 unit remaining
      const prod = await tx.insert('products', { name: 'Chemise Soie Exclusive' });
      const varLast = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'CHM-SOIE-M',
        size: 'M',
        color: 'Noir',
        cost_price: 300000n,
        sale_price: 600000n
      });

      await applyStockMovement(tx, {
        variantId: varLast.id,
        locationId,
        qty: 1,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      // 1. Online shopper attempts to reserve the unit
      const onlineRes = await createReservation(tx, {
        variantId: varLast.id,
        locationId,
        qty: 1,
        orderId: generateUUIDv7()
      });
      assert.ok(onlineRes.id);

      // Now available = 0, on_hand = 1, reserved = 1
      const level = (await tx.query('stock_levels', l => l.variant_id === varLast.id && l.location_id === locationId))[0];
      assert.strictEqual(level.available, 0);

      // 2. Another online order tries to reserve the same unit -> BLOCKED
      await assert.rejects(
        async () => {
          await createReservation(tx, {
            variantId: varLast.id,
            locationId,
            qty: 1,
            orderId: generateUUIDv7()
          });
        },
        /Cannot reserve: requested 1 but available is only 0/
      );

      // 3. Physical POS sale policy (shelf is truth): POS sale succeeds because physical customer is at register
      const posSale = await processSale(tx, {
        locationId,
        cashierId,
        items: [{ variantId: varLast.id, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 600000n }],
        idempotencyKey: 'pos_shelf_sale_last_unit'
      });
      assert.ok(posSale.saleId);

      // Ledger integrity remains strictly preserved (INV-1 holds)
      const finalLevel = (await tx.query('stock_levels', l => l.variant_id === varLast.id && l.location_id === locationId))[0];
      const allMovements = await tx.query('stock_movements', m => m.variant_id === varLast.id && m.location_id === locationId);
      const sumMovements = allMovements.reduce((acc, m) => acc + m.qty, 0);
      assert.strictEqual(finalLevel.on_hand, sumMovements, 'INV-1 holds under concurrent pressure');
    });
  });

  await t.test('UAT-10: End-of-Day Cash Register Close & Z-Report with Cash Variance', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Open register with 5,000 DA opening cash (500,000 centimes)
      const session = await openRegisterSession(tx, { locationId, cashierId, openingCashCentimes: 500000n });

      // Process 2 cash sales:
      // Sale A: 2,800 DA (280,000 centimes)
      await processSale(tx, {
        sessionId: session.id,
        locationId,
        cashierId,
        items: [{ variantId: variant1.id, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 280000n }],
        idempotencyKey: 'uat10_sale_a'
      });

      // Sale B: 1,800 DA (180,000 centimes)
      await processSale(tx, {
        sessionId: session.id,
        locationId,
        cashierId,
        items: [{ variantId: variant3.id, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 180000n }],
        idempotencyKey: 'uat10_sale_b'
      });

      // Mid-day X-Report:
      // Expected Cash = Opening (5,000 DA) + Sales (2,800 + 1,800 = 4,600 DA) = 9,600 DA (960,000 centimes)
      const xReport = await generateXReport(tx, session.id);
      assert.strictEqual(xReport.expectedCash, 960000n, 'Expected cash must be 9,600 DA');
      assert.strictEqual(xReport.salesCount, 2);

      // Close Register Session:
      // Cashier counts 9,400 DA (940,000 centimes) -> Difference is -200 DA (-20,000 centimes deficit)
      const zReport = await closeRegisterSession(tx, {
        sessionId: session.id,
        countedCashCentimes: 940000n
      });

      assert.strictEqual(zReport.status, 'CLOSED');
      assert.strictEqual(zReport.difference, -20000n, 'Difference must record -200 DA (-20,000 centimes)');

      // Verify closed in database
      const closedSession = await tx.findById('register_sessions', session.id);
      assert.strictEqual(closedSession.status, 'CLOSED');
      assert.strictEqual(closedSession.difference_centimes, -20000n);
    });
  });
});
