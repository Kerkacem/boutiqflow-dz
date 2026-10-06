const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  openRegisterSession,
  closeRegisterSession,
  processSale,
  voidSale,
  TENDER_TYPES,
  SALE_STATUSES
} = require('../src/pos/register');
const { applyStockMovement, receiveStock, getVariantStock } = require('../src/inventory/ledger');
const { ROLES } = require('../src/rbac/permissions');

test('Phase 04 — POS Hostile & Boundary Attack Suite', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let locA, cashierA, varA, custA, sessionA;
  let locB, cashierB, varB, custB, sessionB;

  await t.test('Setup isolated tenants, registers, sessions, products, and variants', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Alger Hostile' });
      locA = loc.id;

      const user = await tx.insert('users', { name: 'Cashier A', role: 'cashier', email: 'cashierA@boutiq.dz' });
      cashierA = user.id;

      const cust = await tx.insert('customers', { name: 'Client A', phone: '+213550998877', debt_balance_centimes: 0n });
      custA = cust.id;

      const prod = await tx.insert('products', { name: 'Robe Cocktail' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'ROB-CKTL-BLK-38',
        size: '38',
        color: 'Noir',
        cost_price: 300000n,
        sale_price: 650000n
      });
      varA = variant.id;

      await receiveStock(tx, { variantId: varA, locationId: locA, quantity: 20 });
      sessionA = await openRegisterSession(tx, { locationId: locA, cashierId: cashierA, openingCashCentimes: 500000n });
    });

    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Oran Hostile' });
      locB = loc.id;

      const user = await tx.insert('users', { name: 'Cashier B', role: 'cashier', email: 'cashierB@boutiq.dz' });
      cashierB = user.id;

      const cust = await tx.insert('customers', { name: 'Client B', phone: '+213661887766', debt_balance_centimes: 0n });
      custB = cust.id;

      const prod = await tx.insert('products', { name: 'Costume Homme' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'CST-HOM-BLU-52',
        size: '52',
        color: 'Bleu',
        cost_price: 900000n,
        sale_price: 1800000n
      });
      varB = variant.id;

      await receiveStock(tx, { variantId: varB, locationId: locB, quantity: 15 });
      sessionB = await openRegisterSession(tx, { locationId: locB, cashierId: cashierB, openingCashCentimes: 500000n });
    });
  });

  await t.test('Hostile: Negative quantity, zero quantity, and negative prices rejected', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 1. Negative quantity
      await assert.rejects(
        async () => {
          await processSale(tx, {
            sessionId: sessionA.id,
            locationId: locA,
            cashierId: cashierA,
            items: [{ variantId: varA, qty: -2 }],
            payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 100000n }]
          });
        },
        /Validation Error/
      );

      // 2. Zero quantity
      await assert.rejects(
        async () => {
          await processSale(tx, {
            sessionId: sessionA.id,
            locationId: locA,
            cashierId: cashierA,
            items: [{ variantId: varA, qty: 0 }],
            payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 100000n }]
          });
        },
        /Validation Error: Item quantity must be a strictly positive integer/
      );

      // 3. Negative price override
      await assert.rejects(
        async () => {
          await processSale(tx, {
            sessionId: sessionA.id,
            locationId: locA,
            cashierId: cashierA,
            items: [{ variantId: varA, qty: 1, unitPriceCentimes: -5000n }],
            payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 100000n }]
          });
        },
        /Validation Error: Item unit price cannot be negative/
      );
    });
  });

  await t.test('Hostile: Cart discount exceeding subtotal rejected (INV-04-02)', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 1 item @ 6,500 DA (650,000 centimes), discount requested 7,000 DA (700,000 centimes)
      await assert.rejects(
        async () => {
          await processSale(tx, {
            sessionId: sessionA.id,
            locationId: locA,
            cashierId: cashierA,
            items: [{ variantId: varA, qty: 1 }],
            discountCentimes: 700000n,
            payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 0n }]
          });
        },
        /Validation Error: Cart discount .* cannot exceed subtotal/
      );
    });
  });

  await t.test('Hostile: Insufficient payment rejected (INV-04-03)', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Total is 6,500 DA (650,000 centimes), paid only 5,000 DA (500,000 centimes)
      await assert.rejects(
        async () => {
          await processSale(tx, {
            sessionId: sessionA.id,
            locationId: locA,
            cashierId: cashierA,
            items: [{ variantId: varA, qty: 1 }],
            payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 500000n }]
          });
        },
        /Insufficient payment: total is 650000 but payments sum to 500000 \(INV-04-03\)/
      );
    });
  });

  await t.test('Hostile: Cashier price override and void rejected under RBAC', async () => {
    let completedSaleId;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 1. Cashier attempting unauthorized price override
      await assert.rejects(
        async () => {
          await processSale(tx, {
            sessionId: sessionA.id,
            locationId: locA,
            cashierId: cashierA,
            items: [{ variantId: varA, qty: 1, unitPriceCentimes: 200000n }], // 2,000 DA instead of 6,500 DA
            payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 200000n }],
            actorRole: ROLES.CASHIER
          });
        },
        /Access Denied: Role 'cashier' lacks required permission 'sales:price_override'/
      );

      // Create legitimate sale for void test
      const validSale = await processSale(tx, {
        sessionId: sessionA.id,
        locationId: locA,
        cashierId: cashierA,
        items: [{ variantId: varA, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 650000n }]
      });
      completedSaleId = validSale.saleId;

      // 2. Cashier attempting unauthorized sale void
      await assert.rejects(
        async () => {
          await voidSale(tx, {
            saleId: completedSaleId,
            cashierId: cashierA,
            reason: 'Unauthorized cashier void attempt',
            actorRole: ROLES.CASHIER
          });
        },
        /Access Denied: Role 'cashier' lacks required permission 'sales:void'/
      );
    });
  });

  await t.test('Hostile: Completed sale is immutable and cannot be updated or deleted (INV-04-01, INV-04-07)', async () => {
    let saleId;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const sale = await processSale(tx, {
        sessionId: sessionA.id,
        locationId: locA,
        cashierId: cashierA,
        items: [{ variantId: varA, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 650000n }]
      });
      saleId = sale.saleId;

      // Direct update of financial totals is prohibited at DB layer
      await assert.rejects(
        async () => {
          await tx.update('sales', saleId, { total_centimes: 100n });
        },
        /Sale Immutability Violation: Completed sale 'total_centimes' cannot be modified \(INV-04-01\)/
      );

      // Direct deletion of completed sale is prohibited at DB layer
      await assert.rejects(
        async () => {
          await tx.delete('sales', saleId);
        },
        /Sale Immutability Violation: Completed sales cannot be deleted \(INV-04-07\)/
      );

      // Direct deletion of sale lines is prohibited
      const lines = await tx.query('sale_items', i => i.sale_id === saleId);
      assert.ok(lines.length > 0);
      await assert.rejects(
        async () => {
          await tx.delete('sale_items', lines[0].id);
        },
        /Sale Immutability Violation: Cannot delete lines or payments of completed sale/
      );
    });
  });

  await t.test('Hostile: Cross-Tenant POS operations are completely blocked (INV-04-12)', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 1. Tenant A trying to sell Tenant B variant
      await assert.rejects(
        async () => {
          await processSale(tx, {
            sessionId: sessionA.id,
            locationId: locA,
            cashierId: cashierA,
            items: [{ variantId: varB, qty: 1 }],
            payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 1800000n }]
          });
        },
        /Tenant Isolation \/ Catalog Error: Variant .* not found in tenant \(INV-04-12\)/
      );

      // 2. Tenant A trying to use Tenant B location
      await assert.rejects(
        async () => {
          await processSale(tx, {
            sessionId: sessionA.id,
            locationId: locB,
            cashierId: cashierA,
            items: [{ variantId: varA, qty: 1 }],
            payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 650000n }]
          });
        },
        /Location .* not found or foreign tenant \(INV-04-12\)/
      );

      // 3. Tenant A trying to attach to Tenant B session
      await assert.rejects(
        async () => {
          await processSale(tx, {
            sessionId: sessionB.id,
            locationId: locA,
            cashierId: cashierA,
            items: [{ variantId: varA, qty: 1 }],
            payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 650000n }]
          });
        },
        /Register session .* not found or foreign tenant \(INV-04-12\)/
      );

      // 4. Tenant A trying to charge Customer Credit to Tenant B customer
      await assert.rejects(
        async () => {
          await processSale(tx, {
            sessionId: sessionA.id,
            locationId: locA,
            cashierId: cashierA,
            customerId: custB,
            items: [{ variantId: varA, qty: 1 }],
            payments: [{ tenderType: TENDER_TYPES.CUSTOMER_CREDIT, amountCentimes: 650000n }]
          });
        },
        /Customer .* not found or foreign tenant \(INV-04-12\)/
      );
    });
  });

  await t.test('Hostile: Transaction failure rolls back completely leaving zero partial mutations (INV-04-14)', async () => {
    let stockBefore;
    let salesCountBefore;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      stockBefore = (await getVariantStock(tx, varA, locA)).onHand;
      salesCountBefore = (await tx.query('sales')).length;
    });

    // Run a sale where payment validation fails after item processing
    await assert.rejects(
      async () => {
        await db.withTenant({ tenantId: tenantA }, async (tx) => {
          await processSale(tx, {
            sessionId: sessionA.id,
            locationId: locA,
            cashierId: cashierA,
            items: [{ variantId: varA, qty: 2 }],
            payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: 100n }] // Insufficient -> throws
          });
        });
      },
      /Insufficient payment/
    );

    // Verify ZERO partial mutations
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const stockAfter = (await getVariantStock(tx, varA, locA)).onHand;
      const salesCountAfter = (await tx.query('sales')).length;

      assert.strictEqual(stockAfter, stockBefore, 'Stock must not decrement when sale fails (INV-04-14)');
      assert.strictEqual(salesCountAfter, salesCountBefore, 'No orphan sale record created (INV-04-14)');
    });
  });
});
