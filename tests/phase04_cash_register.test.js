const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  createCashRegister,
  openRegisterSession,
  generateXReport,
  closeRegisterSession,
  adjustCash,
  processSale,
  TENDER_TYPES,
  CASH_TRANSACTION_TYPES
} = require('../src/pos/register');
const { receiveStock } = require('../src/inventory/ledger');
const { ROLES } = require('../src/rbac/permissions');

test('Phase 04 — Cash Register, Cash Sessions & Lifecycle Suite (INV-04-05, 09, 10, 12)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let locA, cashierA, managerA, regA, varA;
  let locB, cashierB, regB;

  await t.test('Setup isolated tenant environments, registers, cashiers, and products', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Alger Centre' });
      locA = loc.id;

      const uCashier = await tx.insert('users', { name: 'Amine Caissier', role: 'cashier', email: 'amine@alger.dz' });
      cashierA = uCashier.id;

      const uManager = await tx.insert('users', { name: 'Karim Gérant', role: 'manager', email: 'karim@alger.dz' });
      managerA = uManager.id;

      const reg = await createCashRegister(tx, { name: 'Caisse Principale 1', locationId: locA, code: 'REG-01' });
      regA = reg.id;

      const prod = await tx.insert('products', { name: 'Polo Piqué DZ' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'POL-PIQ-DZ-M',
        size: 'M',
        color: 'Blanc',
        cost_price: 150000n,
        sale_price: 300000n // 3,000 DA
      });
      varA = variant.id;

      await receiveStock(tx, { variantId: varA, locationId: locA, quantity: 50 });
    });

    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Oran Centre' });
      locB = loc.id;

      const uCashier = await tx.insert('users', { name: 'Yacine Caissier', role: 'cashier', email: 'yacine@oran.dz' });
      cashierB = uCashier.id;

      const reg = await createCashRegister(tx, { name: 'Caisse Oran 1', locationId: locB, code: 'REG-01' });
      regB = reg.id;
    });
  });

  await t.test('INV-04-09: Open cash session with float & reject double-open of same register', async () => {
    let session;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 1. Open session with 20,000 DA float (2,000,000 centimes)
      session = await openRegisterSession(tx, {
        registerId: regA,
        locationId: locA,
        cashierId: cashierA,
        openingCashCentimes: 2000000n,
        notes: 'Session du matin'
      });

      assert.strictEqual(session.status, 'OPEN');
      assert.strictEqual(session.opening_cash_centimes, 2000000n);

      // Verify float cash transaction recorded (INV-04-05)
      const cashTx = await tx.query('cash_transactions', ct => ct.session_id === session.id);
      assert.strictEqual(cashTx.length, 1);
      assert.strictEqual(cashTx[0].type, CASH_TRANSACTION_TYPES.FLOAT_IN);
      assert.strictEqual(cashTx[0].amount_centimes, 2000000n);

      // 2. Double-open attempt on SAME register must fail (INV-04-09)
      await assert.rejects(
        async () => {
          await openRegisterSession(tx, {
            registerId: regA,
            locationId: locA,
            cashierId: cashierA,
            openingCashCentimes: 1000000n
          });
        },
        /Validation Error: Cash register .* already has an active OPEN session \(INV-04-09\)/
      );
    });
  });

  await t.test('Cash Transactions: Sales, Drawer Adjustments & Cashier RBAC', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const openSessions = await tx.query('register_sessions', s => s.register_id === regA && s.status === 'OPEN');
      const sessionId = openSessions[0].id;

      // 1. Process cash sale: 3,000 DA (300,000 centimes)
      await processSale(tx, {
        sessionId,
        registerId: regA,
        locationId: locA,
        cashierId: cashierA,
        items: [{ variantId: varA, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 300000n }],
        idempotencyKey: 'sale-cash-reg-1'
      });

      // 2. Process card sale: 6,000 DA (2 items) -> does NOT increment physical cash drawer
      await processSale(tx, {
        sessionId,
        registerId: regA,
        locationId: locA,
        cashierId: cashierA,
        items: [{ variantId: varA, qty: 2 }],
        payments: [{ tenderType: TENDER_TYPES.CARD, amountCentimes: 600000n }],
        idempotencyKey: 'sale-card-reg-1'
      });

      // 3. Cashier attempting manual cash adjustment without permission rejected (RBAC)
      await assert.rejects(
        async () => {
          await adjustCash(tx, {
            sessionId,
            cashierId: cashierA,
            amountCentimes: 50000n,
            type: CASH_TRANSACTION_TYPES.CASH_OUT,
            reason: 'Petty cash purchase',
            actorRole: ROLES.CASHIER
          });
        },
        /Access Denied: Role 'cashier' lacks required permission 'cash_register:adjust'/
      );

      // 4. Manager executing approved cash withdrawal: 500 DA (50,000 centimes) for cleaning supplies
      const adj = await adjustCash(tx, {
        sessionId,
        cashierId: managerA,
        amountCentimes: 50000n,
        type: CASH_TRANSACTION_TYPES.CASH_OUT,
        reason: 'Achat produits de nettoyage',
        actorRole: ROLES.MANAGER
      });
      assert.strictEqual(adj.amount_centimes, -50000n);

      // 5. Generate mid-day X-Report:
      // Opening: 20,000 DA (2,000,000)
      // Cash Sale: +3,000 DA (+300,000)
      // Card Sale: +6,000 DA (+600,000, in card total only)
      // Cash Out: -500 DA (-50,000)
      // Expected Cash in drawer = 20,000 + 3,000 - 500 = 22,500 DA (2,250,000 centimes)
      const xReport = await generateXReport(tx, sessionId);
      assert.strictEqual(xReport.openingCash, 2000000n);
      assert.strictEqual(xReport.cashTotal, 300000n);
      assert.strictEqual(xReport.cardTotal, 600000n);
      assert.strictEqual(xReport.expectedCash, 2250000n, 'Expected physical cash must be 22,500 DA');
    });
  });

  await t.test('INV-04-10: Close session with Z-Report variance & reject sales on closed session', async () => {
    let closedSessionId;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const openSessions = await tx.query('register_sessions', s => s.register_id === regA && s.status === 'OPEN');
      const sessionId = openSessions[0].id;
      closedSessionId = sessionId;

      // Cashier counts 22,300 DA (2,230,000 centimes) -> Deficit of -200 DA (-20,000 centimes)
      const zReport = await closeRegisterSession(tx, {
        sessionId,
        cashierId: cashierA,
        countedCashCentimes: 2230000n,
        notes: 'Clôture de caisse soir'
      });

      assert.strictEqual(zReport.status, 'CLOSED');
      assert.strictEqual(zReport.expectedCash, 2250000n);
      assert.strictEqual(zReport.countedCash, 2230000n);
      assert.strictEqual(zReport.difference, -20000n, 'Deficit of -200 DA (-20,000 centimes) recorded');

      // Verify closed in DB
      const s = await tx.findById('register_sessions', sessionId);
      assert.strictEqual(s.status, 'CLOSED');
      assert.strictEqual(s.difference_centimes, -20000n);

      // Double close attempt must be rejected
      await assert.rejects(
        async () => {
          await closeRegisterSession(tx, {
            sessionId,
            cashierId: cashierA,
            countedCashCentimes: 2230000n
          });
        },
        /Session Error: Cannot close an already closed register session \(INV-04-10\)/
      );

      // INV-04-10: Processing a normal sale on a closed session MUST be rejected
      await assert.rejects(
        async () => {
          await processSale(tx, {
            sessionId,
            registerId: regA,
            locationId: locA,
            cashierId: cashierA,
            items: [{ variantId: varA, qty: 1 }],
            payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 300000n }]
          });
        },
        /Session Error: Cash session .* is closed\. Normal sales are prohibited \(INV-04-10\)/
      );
    });
  });

  await t.test('INV-04-12: Cross-tenant cash register and session protection', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Tenant A trying to open Tenant B register
      await assert.rejects(
        async () => {
          await openRegisterSession(tx, {
            registerId: regB,
            locationId: locA,
            cashierId: cashierA,
            openingCashCentimes: 1000000n
          });
        },
        /Cash register .* already has an active OPEN session|not found/
      );

      // Tenant A trying to close Tenant B session
      const foreignSessionId = generateUUIDv7();
      await assert.rejects(
        async () => {
          await closeRegisterSession(tx, {
            sessionId: foreignSessionId,
            cashierId: cashierA,
            countedCashCentimes: 1000000n
          });
        },
        /Register session .* not found/
      );
    });
  });
});
