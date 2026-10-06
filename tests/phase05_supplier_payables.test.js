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
  recordSupplierPayment,
  SUPPLIER_PAYMENT_METHODS
} = require('../src/procurement/payables_service');

test('Phase 05 — Supplier Payables & Payments Suite', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let supplierAId = null;
  let supplierBId = null;
  let locationAId = null;
  let locationBId = null;
  let variantAId = null;

  await t.test('Setup isolated tenant environments, suppliers, locations, and variants', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Algiers Depot', type: 'warehouse' });
      locationAId = loc.id;

      const sup = await createSupplier(tx, { name: 'Grossiste El Eulma', phone: '0555123456' });
      supplierAId = sup.id;

      const prod = await tx.insert('products', { name: 'Pantalon Toile' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'PNT-TOILE-BEG-42',
        size: '42',
        color: 'Beige',
        cost_price: 250000n, // 2,500 DA
        sale_price: 500000n
      });
      variantAId = v.id;
    });

    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Constantine Depot', type: 'warehouse' });
      locationBId = loc.id;

      const sup = await createSupplier(tx, { name: 'Fournisseur Est', phone: '0555987654' });
      supplierBId = sup.id;
    });
  });

  await t.test('Receiving goods generates supplier liability and updates outstanding balance', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Balance starts at 0
      const initialBal = await getSupplierBalance(tx, supplierAId);
      assert.strictEqual(initialBal.outstandingPayableCentimes, 0n);

      // Create PO for 40 units @ 2,500 DA = 100,000 DA (10,000,000 centimes)
      const po = await createPurchaseOrder(tx, {
        supplierId: supplierAId,
        locationId: locationAId,
        lines: [{ variantId: variantAId, orderedQty: 40, unitCostCentimes: 250000n }]
      });

      // Receive 40 units
      await receiveGoods(tx, {
        purchaseOrderId: po.id,
        locationId: locationAId,
        receivedLines: [{ purchaseLineId: po.lines[0].id, receivedQty: 40 }]
      });

      const balAfterReceipt = await getSupplierBalance(tx, supplierAId);
      assert.strictEqual(balAfterReceipt.totalReceivedCentimes, 10000000n, 'Total goods received = 100,000 DA');
      assert.strictEqual(balAfterReceipt.totalPaidCentimes, 0n);
      assert.strictEqual(balAfterReceipt.outstandingPayableCentimes, 10000000n, 'Outstanding payable = 100,000 DA');
    });
  });

  await t.test('Supplier payment reduces outstanding balance and cannot exceed payable (INV-05-07)', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 1. Attempt paying 150,000 DA when outstanding is 100,000 DA (INV-05-07)
      await assert.rejects(
        recordSupplierPayment(tx, {
          supplierId: supplierAId,
          amountCentimes: 15000000n, // 150,000 DA
          paymentMethod: SUPPLIER_PAYMENT_METHODS.BANK_TRANSFER
        }),
        /Invariant Violation INV-05-07.*exceeds outstanding payable balance/
      );

      // 2. Negative and zero payment rejected
      await assert.rejects(
        recordSupplierPayment(tx, {
          supplierId: supplierAId,
          amountCentimes: 0n
        }),
        /Validation Error.*strictly positive/
      );
      await assert.rejects(
        recordSupplierPayment(tx, {
          supplierId: supplierAId,
          amountCentimes: -50000n
        }),
        /Validation Error.*strictly positive/
      );

      // 3. Valid partial payment of 40,000 DA (4,000,000 centimes)
      const pay1 = await recordSupplierPayment(tx, {
        supplierId: supplierAId,
        amountCentimes: 4000000n,
        paymentMethod: SUPPLIER_PAYMENT_METHODS.BARIDIMOB,
        reference: 'TX-BARIDI-99281'
      });
      assert.ok(pay1.payment.id);

      const balAfterPay1 = await getSupplierBalance(tx, supplierAId);
      assert.strictEqual(balAfterPay1.totalPaidCentimes, 4000000n);
      assert.strictEqual(balAfterPay1.outstandingPayableCentimes, 6000000n, 'Outstanding balance is now 60,000 DA');

      // 4. Pay remaining 60,000 DA
      await recordSupplierPayment(tx, {
        supplierId: supplierAId,
        amountCentimes: 6000000n,
        paymentMethod: SUPPLIER_PAYMENT_METHODS.CHECK,
        reference: 'CHK-001289'
      });

      const balAfterPay2 = await getSupplierBalance(tx, supplierAId);
      assert.strictEqual(balAfterPay2.totalPaidCentimes, 10000000n);
      assert.strictEqual(balAfterPay2.outstandingPayableCentimes, 0n, 'Outstanding balance is now exactly 0 DA');

      // 5. Subsequent payment rejected because balance is 0
      await assert.rejects(
        recordSupplierPayment(tx, {
          supplierId: supplierAId,
          amountCentimes: 100000n,
          paymentMethod: SUPPLIER_PAYMENT_METHODS.CASH
        }),
        /Invariant Violation INV-05-07.*exceeds outstanding payable balance/
      );
    });
  });

  await t.test('Purchase return decreases supplier liability', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Receive new shipment: 10 units @ 2,500 DA = 25,000 DA (2,500,000 centimes)
      const po = await createPurchaseOrder(tx, {
        supplierId: supplierAId,
        locationId: locationAId,
        lines: [{ variantId: variantAId, orderedQty: 10, unitCostCentimes: 250000n }]
      });
      await receiveGoods(tx, {
        purchaseOrderId: po.id,
        locationId: locationAId,
        receivedLines: [{ purchaseLineId: po.lines[0].id, receivedQty: 10 }]
      });

      const balBeforeReturn = await getSupplierBalance(tx, supplierAId);
      assert.strictEqual(balBeforeReturn.outstandingPayableCentimes, 2500000n);

      // Return 2 defective units to supplier = 2 * 2,500 = 5,000 DA (500,000 centimes)
      await returnGoodsToSupplier(tx, {
        purchaseOrderId: po.id,
        locationId: locationAId,
        returnLines: [{ purchaseLineId: po.lines[0].id, returnedQty: 2 }],
        reason: 'FABRIC_DEFECT'
      });

      const balAfterReturn = await getSupplierBalance(tx, supplierAId);
      assert.strictEqual(balAfterReturn.totalReturnedCentimes, 500000n);
      assert.strictEqual(balAfterReturn.outstandingPayableCentimes, 2000000n, 'Outstanding payable adjusted down to 20,000 DA');
    });
  });

  await t.test('INV-05-11: Cross-tenant supplier payment and balance lookup is strictly rejected', async () => {
    // Tenant B cannot access Tenant A supplier balance
    await db.withTenant({ tenantId: tenantB }, async (txB) => {
      await assert.rejects(
        getSupplierBalance(txB, supplierAId),
        /Supplier not found/
      );

      // Tenant B cannot record payment to Tenant A supplier
      await assert.rejects(
        recordSupplierPayment(txB, {
          supplierId: supplierAId,
          amountCentimes: 500000n
        }),
        /Supplier not found/
      );
    });
  });

  await t.test('Supplier payments are permanent and cannot be deleted', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const payments = await tx.query('supplier_payments', p => p.supplier_id === supplierAId);
      assert.ok(payments.length > 0);

      await assert.rejects(
        tx.delete('supplier_payments', payments[0].id),
        /Supplier Payment Immutability Violation.*cannot be deleted/
      );
    });
  });
});
