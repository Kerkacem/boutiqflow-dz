const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  openRegisterSession,
  processSale,
  TENDER_TYPES
} = require('../src/pos/register');
const { receiveStock } = require('../src/inventory/ledger');

test('Phase 04 — Payment Integrity & Mathematical Exactness Suite (INV-04-02, 03, 05)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let locationId, cashierId, customerId, session;
  let varA, varB;

  await t.test('Setup tenant, location, customer, session, and inventory', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Alger Paiement' });
      locationId = loc.id;

      const user = await tx.insert('users', { name: 'Karim Caissier', role: 'cashier', email: 'karim@paiement.dz' });
      cashierId = user.id;

      const cust = await tx.insert('customers', { name: 'Mourad Belkacem', phone: '+213550123456', debt_balance_centimes: 0n });
      customerId = cust.id;

      const p1 = await tx.insert('products', { name: 'Veste Cuir Pilote' });
      const v1 = await tx.insert('product_variants', {
        product_id: p1.id,
        sku: 'VST-CUIR-PIL-L',
        size: 'L',
        color: 'Noir',
        cost_price: 600000n,
        sale_price: 1200000n // 12,000 DA (1,200,000 centimes)
      });
      varA = v1.id;

      const p2 = await tx.insert('products', { name: 'Chemise Blanche Lin' });
      const v2 = await tx.insert('product_variants', {
        product_id: p2.id,
        sku: 'CHM-LIN-BLC-42',
        size: '42',
        color: 'Blanc',
        cost_price: 180000n,
        sale_price: 350000n  // 3,500 DA (350,000 centimes)
      });
      varB = v2.id;

      await receiveStock(tx, { variantId: varA, locationId, quantity: 20 });
      await receiveStock(tx, { variantId: varB, locationId, quantity: 20 });

      session = await openRegisterSession(tx, { locationId, cashierId, openingCashCentimes: 1000000n });
    });
  });

  await t.test('Single Tender Payments: 100% Cash, 100% Card, 100% BaridiMob (INV-04-03)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. 100% Cash: 3,500 DA
      const cashSale = await processSale(tx, {
        sessionId: session.id,
        locationId,
        cashierId,
        items: [{ variantId: varB, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 350000n }]
      });
      assert.strictEqual(cashSale.total, 350000n);
      assert.strictEqual(cashSale.changeDue, 0n);

      // Verify cash transaction recorded (INV-04-05)
      const cashTxs = await tx.query('cash_transactions', ct => ct.reference_id === cashSale.saleId);
      assert.strictEqual(cashTxs.length, 1);
      assert.strictEqual(cashTxs[0].amount_centimes, 350000n);

      // 2. 100% Card: 12,000 DA
      const cardSale = await processSale(tx, {
        sessionId: session.id,
        locationId,
        cashierId,
        items: [{ variantId: varA, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CARD, amountCentimes: 1200000n }]
      });
      assert.strictEqual(cardSale.total, 1200000n);

      // 3. 100% BaridiMob: 3,500 DA
      const baridiSale = await processSale(tx, {
        sessionId: session.id,
        locationId,
        cashierId,
        items: [{ variantId: varB, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.BARIDIMOB, amountCentimes: 350000n, reference: 'RIP-00799999000123' }]
      });
      assert.strictEqual(baridiSale.total, 350000n);
    });
  });

  await t.test('Split / Mixed Payment: Cash + Card + BaridiMob + Customer Credit (INV-04-03)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Purchase: 1 Veste (12,000 DA) + 1 Chemise (3,500 DA) = 15,500 DA (1,550,000 centimes)
      // Cart discount: 500 DA (50,000 centimes)
      // Total = 15,000 DA (1,500,000 centimes)
      // Mixed Tenders:
      // - Cash: 4,000 DA (400,000 centimes)
      // - Card (CIB/Satim): 5,000 DA (500,000 centimes)
      // - BaridiMob: 3,000 DA (300,000 centimes)
      // - Customer Credit: 3,000 DA (300,000 centimes)
      // Sum = 4,000 + 5,000 + 3,000 + 3,000 = 15,000 DA (1,500,000 centimes)
      const mixedSale = await processSale(tx, {
        sessionId: session.id,
        locationId,
        cashierId,
        customerId,
        items: [
          { variantId: varA, qty: 1 },
          { variantId: varB, qty: 1 }
        ],
        discountCentimes: 50000n,
        payments: [
          { tenderType: TENDER_TYPES.CASH, amountCentimes: 400000n },
          { tenderType: TENDER_TYPES.CARD, amountCentimes: 500000n },
          { tenderType: TENDER_TYPES.BARIDIMOB, amountCentimes: 300000n },
          { tenderType: TENDER_TYPES.CUSTOMER_CREDIT, amountCentimes: 300000n }
        ]
      });

      assert.strictEqual(mixedSale.subtotal, 1550000n);
      assert.strictEqual(mixedSale.total, 1500000n);
      assert.strictEqual(mixedSale.paymentsSum, 1500000n);
      assert.strictEqual(mixedSale.changeDue, 0n);

      // Verify exact customer debt update
      const customer = await tx.findById('customers', customerId);
      assert.strictEqual(customer.debt_balance_centimes, 300000n, 'Customer debt balance must be 3,000 DA');

      // Verify cash drawer received exactly +4,000 DA (INV-04-05)
      const cashTxs = await tx.query('cash_transactions', ct => ct.reference_id === mixedSale.saleId);
      assert.strictEqual(cashTxs.length, 1);
      assert.strictEqual(cashTxs[0].amount_centimes, 400000n);
    });
  });

  await t.test('Cash Overpayment & Change Calculation with Net Drawer Movement (INV-04-05)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Item: Chemise @ 3,500 DA (350,000 centimes)
      // Customer hands 4,000 DA cash (400,000 centimes)
      // Expected Change Due: 500 DA (50,000 centimes)
      // Net Cash added to drawer: 4,000 - 500 = 3,500 DA (350,000 centimes)
      const sale = await processSale(tx, {
        sessionId: session.id,
        locationId,
        cashierId,
        items: [{ variantId: varB, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 400000n }]
      });

      assert.strictEqual(sale.total, 350000n);
      assert.strictEqual(sale.paymentsSum, 400000n);
      assert.strictEqual(sale.changeDue, 50000n, 'Change due must be 500 DA');

      // Net drawer movement must equal net sale amount (INV-04-05)
      const cashTxs = await tx.query('cash_transactions', ct => ct.reference_id === sale.saleId);
      assert.strictEqual(cashTxs.length, 1);
      assert.strictEqual(cashTxs[0].amount_centimes, 350000n, 'Net cash added to drawer is 3,500 DA (4,000 in - 500 out)');
    });
  });
});
