const test = require('node:test');
const assert = require('node:assert');
const { recordExpense, recordIncome, generatePnLReport } = require('../src/finance/finance');
const { detectDeadStock, analyzeSizeCurve, generateCreditAgingReport, exportToCSV } = require('../src/finance/reports');
const { processSale, TENDER_TYPES } = require('../src/pos/register');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase P6 — Finance, True P&L, Dead Stock & Size Curves', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let locationId = null;
  let cashierId = null;
  let rentCatId = null;
  let wagesCatId = null;
  let utilCatId = null;

  await t.test('Setup tenant, location, cashier, and expense categories', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Principale', type: 'shop' });
      locationId = loc.id;

      const user = await tx.insert('users', { name: 'Amine', email: 'amine@shop.dz', role: 'cashier', password_hash: 'xxx' });
      cashierId = user.id;

      const cat1 = await tx.insert('expense_categories', { name: 'Loyer (Rent)' });
      const cat2 = await tx.insert('expense_categories', { name: 'Salaires (Wages)' });
      const cat3 = await tx.insert('expense_categories', { name: 'Électricité & Eau' });
      rentCatId = cat1.id;
      wagesCatId = cat2.id;
      utilCatId = cat3.id;
    });
  });

  await t.test('UAT-11: 30 Days of Seeded Sales, COGS, and Expenses Reconcile Mathematically to the Centime', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const prod = await tx.insert('products', { name: 'Ensemble Costume Homme' });
      const v1 = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'CST-GRIS-48',
        size: '48',
        color: 'Gris',
        cost_price: 2300000n, // Unit cost: 23,000 DA (2,300,000 centimes)
        sale_price: 4500000n  // Sale price: 45,000 DA (4,500,000 centimes)
      });

      // Seed 20 units
      await applyStockMovement(tx, {
        variantId: v1.id,
        locationId,
        qty: 20,
        costPriceCentimes: 2300000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      // Process 10 completed sales
      // Revenue = 10 * 45,000 DA = 450,000 DA
      // COGS = 10 * 23,000 DA = 230,000 DA
      // Gross Profit = 220,000 DA
      for (let day = 1; day <= 10; day++) {
        await processSale(tx, {
          locationId,
          cashierId,
          items: [{ variantId: v1.id, qty: 1 }],
          payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 4500000n }],
          idempotencyKey: `uat11_sale_day_${day}`
        });
      }

      // Record Expenses = 80,000 + 70,000 + 25,000 = 175,000 DA
      await recordExpense(tx, {
        categoryId: rentCatId,
        amountCentimes: 8000000n,
        description: 'Loyer local commercial Octobre 2026',
        expenseDate: '2026-10-01'
      });

      await recordExpense(tx, {
        categoryId: wagesCatId,
        amountCentimes: 7000000n,
        description: 'Salaires employés boutique',
        expenseDate: '2026-10-05'
      });

      await recordExpense(tx, {
        categoryId: utilCatId,
        amountCentimes: 2500000n,
        description: 'Facture Sonelgaz',
        expenseDate: '2026-10-06'
      });

      const pnl = await generatePnLReport(tx, {});

      assert.strictEqual(pnl.salesCount, 10);
      assert.strictEqual(pnl.grossSales, 45000000n);
      assert.strictEqual(pnl.cogs, 23000000n);
      assert.strictEqual(pnl.grossProfit, 22000000n);
      assert.strictEqual(pnl.totalExpenses, 17500000n);
      assert.strictEqual(pnl.netProfit, 4500000n, 'Net Profit must equal exactly 45,000 DA');
    });
  });

  await t.test('Dead Stock Detector: Flags items with zero sales in 60 days', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const p = await tx.insert('products', { name: 'Manteau Hiver Lourd' });
      const dormantVariant = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'MNT-HIV-XL',
        size: 'XL',
        color: 'Noir',
        cost_price: 500000n,
        sale_price: 950000n
      });

      await applyStockMovement(tx, {
        variantId: dormantVariant.id,
        locationId,
        qty: 4,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      const deadStock = await detectDeadStock(tx, 60);
      assert.ok(deadStock.length > 0);

      const foundDormant = deadStock.find(d => d.variantId === dormantVariant.id);
      assert.ok(foundDormant);
      assert.strictEqual(foundDormant.onHand, 4);
      assert.strictEqual(foundDormant.tiedUpCapitalCentimes, 2000000n);
    });
  });

  await t.test('Size-Curve Sell-Through Analysis: Identifies top selling sizes', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const curve = await analyzeSizeCurve(tx);
      assert.ok(Array.isArray(curve));
      assert.ok(curve.length > 0);

      for (const entry of curve) {
        assert.ok(entry.size);
        assert.strictEqual(typeof entry.unitsSold, 'number');
        assert.ok(entry.sellThroughRate.endsWith('%'));
      }
    });
  });

  await t.test('Customer Credit Aging & CSV Export Engine', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Seed debtor customer
      const cust = await tx.insert('customers', {
        name: 'Youcef Belaili',
        phone: '+213550998877',
        debt_balance_centimes: 1200000n // 12,000 DA debt
      });

      await tx.insert('customer_ledger', {
        customer_id: cust.id,
        type: 'SALE_CREDIT',
        amount_centimes: 1200000n,
        created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() // 10 days ago (0-30 bucket)
      });

      const aging = await generateCreditAgingReport(tx);
      assert.strictEqual(aging.length, 1);
      assert.strictEqual(aging[0].name, 'Youcef Belaili');
      assert.strictEqual(aging[0].current_0_30d, 1200000n);

      const csv = exportToCSV(aging, {
        name: 'Nom Client',
        phone: 'Téléphone',
        totalDebtCentimes: 'Dette Totale'
      });

      assert.ok(csv.startsWith('"Nom Client","Téléphone"'));
      assert.ok(csv.includes('Youcef Belaili'));
      assert.ok(csv.includes('1200000'));
    });
  });
});
