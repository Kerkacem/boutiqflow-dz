const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  openRegisterSession,
  processSale,
  processRefund,
  TENDER_TYPES,
  SALE_STATUSES
} = require('../src/pos/register');
const { receiveStock, getVariantStock, getStockLedger, MOVEMENT_TYPES } = require('../src/inventory/ledger');
const { ROLES } = require('../src/rbac/permissions');

test('Phase 04 — Refund Domain, Inventory Restock & Ceiling Protection Suite (INV-04-06, 11, 12)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let locA, cashierA, managerA, sessionA;
  let varA1, varA2;
  let locB, cashierB, sessionB, varB;

  await t.test('Setup isolated tenant environments, catalog, and inventory', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Alger Retours' });
      locA = loc.id;

      const uCashier = await tx.insert('users', { name: 'Ali Caissier', role: 'cashier', email: 'ali@retours.dz' });
      cashierA = uCashier.id;

      const uManager = await tx.insert('users', { name: 'Nadia Gérante', role: 'manager', email: 'nadia@retours.dz' });
      managerA = uManager.id;

      const p1 = await tx.insert('products', { name: 'Abaya Moderne' });
      const v1 = await tx.insert('product_variants', {
        product_id: p1.id,
        sku: 'ABY-MOD-BLK-L',
        size: 'L',
        color: 'Noir',
        cost_price: 350000n,
        sale_price: 700000n // 7,000 DA
      });
      varA1 = v1.id;

      const p2 = await tx.insert('products', { name: 'Foulard Soie' });
      const v2 = await tx.insert('product_variants', {
        product_id: p2.id,
        sku: 'FLD-SOIE-BEI',
        size: 'TU',
        color: 'Beige',
        cost_price: 80000n,
        sale_price: 180000n  // 1,800 DA
      });
      varA2 = v2.id;

      await receiveStock(tx, { variantId: varA1, locationId: locA, quantity: 20 });
      await receiveStock(tx, { variantId: varA2, locationId: locA, quantity: 30 });

      sessionA = await openRegisterSession(tx, { locationId: locA, cashierId: cashierA, openingCashCentimes: 1000000n });
    });

    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Constantine Retours' });
      locB = loc.id;

      const uCashier = await tx.insert('users', { name: 'Farid Caissier', role: 'cashier', email: 'farid@retours.dz' });
      cashierB = uCashier.id;

      const p = await tx.insert('products', { name: 'Gilet Laine B' });
      const v = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'GLT-LAIN-B',
        size: 'M',
        color: 'Gris',
        cost_price: 200000n,
        sale_price: 450000n
      });
      varB = v.id;

      await receiveStock(tx, { variantId: varB, locationId: locB, quantity: 10 });
      sessionB = await openRegisterSession(tx, { locationId: locB, cashierId: cashierB, openingCashCentimes: 500000n });
    });
  });

  await t.test('Full Refund: Restocks inventory, reverses cash, updates sale status to REFUNDED', async () => {
    let saleId;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 1. Process sale of 2 Abayas @ 7,000 DA = 14,000 DA (1,400,000 centimes)
      const sale = await processSale(tx, {
        sessionId: sessionA.id,
        locationId: locA,
        cashierId: cashierA,
        items: [{ variantId: varA1, qty: 2 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 1400000n }]
      });
      saleId = sale.saleId;

      const stockAfterSale = await getVariantStock(tx, varA1, locA);
      assert.strictEqual(stockAfterSale.onHand, 18, 'Stock decremented to 18 (20 - 2)');

      const saleItem = (await tx.query('sale_items', i => i.sale_id === saleId))[0];

      // 2. Process Full Refund: 2 units
      const refund = await processRefund(tx, {
        saleId,
        sessionId: sessionA.id,
        cashierId: managerA,
        itemsToRefund: [{ saleItemId: saleItem.id, qty: 2, reason: 'Taille non conforme' }],
        reason: 'Client demande remboursement total',
        actorRole: ROLES.MANAGER
      });

      assert.strictEqual(refund.status, 'COMPLETED');
      assert.strictEqual(refund.saleStatus, SALE_STATUSES.REFUNDED);
      assert.strictEqual(refund.totalRefundCentimes, 1400000n);

      // Verify inventory restocked (+2 units back to 20)
      const stockAfterRefund = await getVariantStock(tx, varA1, locA);
      assert.strictEqual(stockAfterRefund.onHand, 20, 'Stock restored to 20 after full refund');

      // Verify cash transaction recorded negative cash in drawer (-14,000 DA)
      const cashTxs = await tx.query('cash_transactions', ct => ct.reference_id === refund.refundId);
      assert.strictEqual(cashTxs.length, 1);
      assert.strictEqual(cashTxs[0].amount_centimes, -1400000n);

      // Verify sale record status updated
      const updatedSale = await tx.findById('sales', saleId);
      assert.strictEqual(updatedSale.status, SALE_STATUSES.REFUNDED);
    });
  });

  await t.test('Partial Refund: Sale status becomes PARTIALLY_REFUNDED', async () => {
    let saleId, itemAbaya, itemFoulard;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Sale of: 2 Abayas (14,000 DA) + 1 Foulard (1,800 DA) = 15,800 DA
      const sale = await processSale(tx, {
        sessionId: sessionA.id,
        locationId: locA,
        cashierId: cashierA,
        items: [
          { variantId: varA1, qty: 2 },
          { variantId: varA2, qty: 1 }
        ],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 1580000n }]
      });
      saleId = sale.saleId;

      const items = await tx.query('sale_items', i => i.sale_id === saleId);
      itemAbaya = items.find(i => i.variant_id === varA1);
      itemFoulard = items.find(i => i.variant_id === varA2);

      // Partial Refund: 1 Abaya refunded (Foulard and other Abaya kept)
      const partialRefund = await processRefund(tx, {
        saleId,
        sessionId: sessionA.id,
        cashierId: managerA,
        itemsToRefund: [{ saleItemId: itemAbaya.id, qty: 1, reason: 'Couleur inadaptée' }],
        reason: 'Remboursement partiel 1 robe',
        actorRole: ROLES.MANAGER
      });

      assert.strictEqual(partialRefund.saleStatus, SALE_STATUSES.PARTIALLY_REFUNDED);
      assert.strictEqual(partialRefund.totalRefundCentimes, 700000n, 'Refund amount = 7,000 DA');

      const updatedSale = await tx.findById('sales', saleId);
      assert.strictEqual(updatedSale.status, SALE_STATUSES.PARTIALLY_REFUNDED);
    });
  });

  await t.test('INV-04-06: Over-refund and duplicate refund attempts strictly rejected', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Sale of: 1 Abaya (7,000 DA) + 1 Foulard (1,800 DA)
      const sale = await processSale(tx, {
        sessionId: sessionA.id,
        locationId: locA,
        cashierId: cashierA,
        items: [
          { variantId: varA1, qty: 1 },
          { variantId: varA2, qty: 1 }
        ],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 880000n }]
      });

      const items = await tx.query('sale_items', i => i.sale_id === sale.saleId);
      const abayaItem = items.find(i => i.variant_id === varA1);
      const foulardItem = items.find(i => i.variant_id === varA2);

      // 1. Over-refund attempt: Customer bought 1 Abaya, asks refund for 2
      await assert.rejects(
        async () => {
          await processRefund(tx, {
            saleId: sale.saleId,
            sessionId: sessionA.id,
            cashierId: managerA,
            itemsToRefund: [{ saleItemId: abayaItem.id, qty: 2 }],
            actorRole: ROLES.MANAGER
          });
        },
        /Refund Error: Requested refund qty \(2\) exceeds available remaining qty \(1\)/
      );

      // 2. Refund the 1 valid Abaya line -> sale is now PARTIALLY_REFUNDED
      const partialRes = await processRefund(tx, {
        saleId: sale.saleId,
        sessionId: sessionA.id,
        cashierId: managerA,
        itemsToRefund: [{ saleItemId: abayaItem.id, qty: 1 }],
        actorRole: ROLES.MANAGER
      });
      assert.strictEqual(partialRes.saleStatus, SALE_STATUSES.PARTIALLY_REFUNDED);

      // 3. Duplicate refund attempt: trying to refund the Abaya line again while sale is PARTIALLY_REFUNDED
      await assert.rejects(
        async () => {
          await processRefund(tx, {
            saleId: sale.saleId,
            sessionId: sessionA.id,
            cashierId: managerA,
            itemsToRefund: [{ saleItemId: abayaItem.id, qty: 1 }],
            actorRole: ROLES.MANAGER
          });
        },
        /Refund Error: Requested refund qty \(1\) exceeds available remaining qty \(0\)/
      );

      // 4. Refund remaining Foulard -> sale becomes fully REFUNDED
      const fullRes = await processRefund(tx, {
        saleId: sale.saleId,
        sessionId: sessionA.id,
        cashierId: managerA,
        itemsToRefund: [{ saleItemId: foulardItem.id, qty: 1 }],
        actorRole: ROLES.MANAGER
      });
      assert.strictEqual(fullRes.saleStatus, SALE_STATUSES.REFUNDED);

      // 5. Trying to refund an already fully REFUNDED sale
      await assert.rejects(
        async () => {
          await processRefund(tx, {
            saleId: sale.saleId,
            sessionId: sessionA.id,
            cashierId: managerA,
            itemsToRefund: [{ saleItemId: foulardItem.id, qty: 1 }],
            actorRole: ROLES.MANAGER
          });
        },
        /Sale Error: Cannot refund sale in status 'REFUNDED'/
      );
    });
  });

  await t.test('INV-04-12: Cross-tenant refund is impossible', async () => {
    let saleBId, saleBItemId;
    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const saleB = await processSale(tx, {
        sessionId: sessionB.id,
        locationId: locB,
        cashierId: cashierB,
        items: [{ variantId: varB, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 450000n }]
      });
      saleBId = saleB.saleId;
      saleBItemId = (await tx.query('sale_items', i => i.sale_id === saleBId))[0].id;
    });

    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Tenant A manager trying to refund Tenant B sale
      await assert.rejects(
        async () => {
          await processRefund(tx, {
            saleId: saleBId,
            sessionId: sessionA.id,
            cashierId: managerA,
            itemsToRefund: [{ saleItemId: saleBItemId, qty: 1 }],
            actorRole: ROLES.MANAGER
          });
        },
        /Sale .* not found or foreign tenant \(INV-04-12\)/
      );
    });
  });

  await t.test('INV-04-11: Refund after variant or product archived preserves historical integrity', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const p = await tx.insert('products', { name: 'Chemise Fin De Série' });
      const v = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'CHM-FIN-SERIE-M',
        size: 'M',
        color: 'Blanc',
        cost_price: 100000n,
        sale_price: 250000n
      });
      await receiveStock(tx, { variantId: v.id, locationId: locA, quantity: 5 });

      const sale = await processSale(tx, {
        sessionId: sessionA.id,
        locationId: locA,
        cashierId: cashierA,
        items: [{ variantId: v.id, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 250000n }]
      });

      const saleItem = (await tx.query('sale_items', i => i.sale_id === sale.saleId))[0];

      // Archive product and variant after sale
      await tx.update('products', p.id, { is_active: false });
      await tx.update('product_variants', v.id, { is_active: false });

      // Customer returns archived item: refund succeeds and restocks
      const refund = await processRefund(tx, {
        saleId: sale.saleId,
        sessionId: sessionA.id,
        cashierId: managerA,
        itemsToRefund: [{ saleItemId: saleItem.id, qty: 1, reason: 'Retour article archivé' }],
        actorRole: ROLES.MANAGER
      });

      assert.strictEqual(refund.status, 'COMPLETED');

      // Historical sale record remains unchanged (INV-04-11)
      const historicalSale = await tx.findById('sales', sale.saleId);
      assert.strictEqual(historicalSale.total_centimes, 250000n);
      assert.strictEqual(historicalSale.receipt_number, sale.receiptNumber);
    });
  });

  await t.test('RBAC: Cashier without manager override cannot process refund', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const sale = await processSale(tx, {
        sessionId: sessionA.id,
        locationId: locA,
        cashierId: cashierA,
        items: [{ variantId: varA1, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 700000n }]
      });
      const saleItem = (await tx.query('sale_items', i => i.sale_id === sale.saleId))[0];

      // Cashier role directly executing refund
      await assert.rejects(
        async () => {
          await processRefund(tx, {
            saleId: sale.saleId,
            sessionId: sessionA.id,
            cashierId: cashierA,
            itemsToRefund: [{ saleItemId: saleItem.id, qty: 1 }],
            actorRole: ROLES.CASHIER
          });
        },
        /Access Denied: Role 'cashier' lacks required permission 'sales:refund'/
      );
    });
  });
});
