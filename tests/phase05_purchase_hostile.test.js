const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  createSupplier,
  createPurchaseOrder,
  receiveGoods,
  returnGoodsToSupplier,
  PO_STATUSES
} = require('../src/procurement/procurement_service');
const { authorize, PERMISSIONS } = require('../src/rbac/permissions');

test('Phase 05 — Purchase Hostile & Boundary Attack Suite', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let supplierAId = null;
  let supplierBId = null;
  let locationAId = null;
  let locationBId = null;
  let variantAId = null;
  let variantBId = null;

  await t.test('Setup isolated tenant environments, suppliers, locations, and variants', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Algiers Central Depot', type: 'warehouse' });
      locationAId = loc.id;

      const sup = await createSupplier(tx, { name: 'Grossiste Bab Ezzouar', phone: '0550123456' });
      supplierAId = sup.id;

      const prod = await tx.insert('products', { name: 'Veste Cuir Homme' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'VST-CUIR-BLK-L',
        size: 'L',
        color: 'Noir',
        cost_price: 600000n, // 6,000 DA
        sale_price: 1200000n // 12,000 DA
      });
      variantAId = v.id;
    });

    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Oran Depot', type: 'warehouse' });
      locationBId = loc.id;

      const sup = await createSupplier(tx, { name: 'Fournisseur Medina Oran', phone: '0660987654' });
      supplierBId = sup.id;

      const prod = await tx.insert('products', { name: 'Robe Soie Femme' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'ROB-SOIE-RED-M',
        size: 'M',
        color: 'Rouge',
        cost_price: 450000n,
        sale_price: 900000n
      });
      variantBId = v.id;
    });
  });

  await t.test('Hostile: Negative quantity, zero quantity, and negative costs rejected on PO creation', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // 1. Negative quantity
      await assert.rejects(
        createPurchaseOrder(tx, {
          supplierId: supplierAId,
          locationId: locationAId,
          lines: [{ variantId: variantAId, orderedQty: -5, unitCostCentimes: 500000n }]
        }),
        /Validation Error.*strictly positive integer/
      );

      // 2. Zero quantity
      await assert.rejects(
        createPurchaseOrder(tx, {
          supplierId: supplierAId,
          locationId: locationAId,
          lines: [{ variantId: variantAId, orderedQty: 0, unitCostCentimes: 500000n }]
        }),
        /Validation Error.*strictly positive integer/
      );

      // 3. Decimal quantity
      await assert.rejects(
        createPurchaseOrder(tx, {
          supplierId: supplierAId,
          locationId: locationAId,
          lines: [{ variantId: variantAId, orderedQty: 5.5, unitCostCentimes: 500000n }]
        }),
        /Validation Error.*strictly positive integer/
      );

      // 4. Negative cost
      await assert.rejects(
        createPurchaseOrder(tx, {
          supplierId: supplierAId,
          locationId: locationAId,
          lines: [{ variantId: variantAId, orderedQty: 10, unitCostCentimes: -1000n }]
        }),
        /Validation Error.*cannot be negative/
      );

      // 5. Empty lines
      await assert.rejects(
        createPurchaseOrder(tx, {
          supplierId: supplierAId,
          locationId: locationAId,
          lines: []
        }),
        /Validation Error.*at least one line/
      );
    });
  });

  await t.test('INV-05-01: Purchase Order creation does NOT mutate inventory levels or movements', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const movementsBefore = await tx.query('stock_movements');
      const levelsBefore = await tx.query('stock_levels');

      const po = await createPurchaseOrder(tx, {
        supplierId: supplierAId,
        locationId: locationAId,
        lines: [{ variantId: variantAId, orderedQty: 50, unitCostCentimes: 550000n }]
      });

      assert.ok(po.id);
      assert.strictEqual(po.status, PO_STATUSES.ORDERED);

      const movementsAfter = await tx.query('stock_movements');
      const levelsAfter = await tx.query('stock_levels');

      assert.strictEqual(movementsAfter.length, movementsBefore.length, 'INV-05-01: Zero stock movements created on PO creation');
      assert.strictEqual(levelsAfter.length, levelsBefore.length, 'INV-05-01: Zero stock levels created on PO creation');
    });
  });

  await t.test('INV-05-03: Over-receiving beyond ordered quantity is strictly rejected', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const po = await createPurchaseOrder(tx, {
        supplierId: supplierAId,
        locationId: locationAId,
        lines: [{ variantId: variantAId, orderedQty: 20, unitCostCentimes: 600000n }]
      });

      const lineId = po.lines[0].id;

      // Attempt receiving 21 units (ceiling is 20)
      await assert.rejects(
        receiveGoods(tx, {
          purchaseOrderId: po.id,
          locationId: locationAId,
          receivedLines: [{ purchaseLineId: lineId, receivedQty: 21 }]
        }),
        /Invariant Violation INV-05-03.*exceeds ordered quantity/
      );

      // Partial receive 15 units (allowed)
      const res1 = await receiveGoods(tx, {
        purchaseOrderId: po.id,
        locationId: locationAId,
        receivedLines: [{ purchaseLineId: lineId, receivedQty: 15 }]
      });
      assert.strictEqual(res1.purchaseOrderStatus, PO_STATUSES.PARTIALLY_RECEIVED);

      // Attempt receiving 6 more (total would be 21 > 20) -> must fail!
      await assert.rejects(
        receiveGoods(tx, {
          purchaseOrderId: po.id,
          locationId: locationAId,
          receivedLines: [{ purchaseLineId: lineId, receivedQty: 6 }]
        }),
        /Invariant Violation INV-05-03.*exceeds ordered quantity/
      );

      // Receiving exactly 5 more (total = 20) -> succeeds and status becomes RECEIVED
      const res2 = await receiveGoods(tx, {
        purchaseOrderId: po.id,
        locationId: locationAId,
        receivedLines: [{ purchaseLineId: lineId, receivedQty: 5 }]
      });
      assert.strictEqual(res2.purchaseOrderStatus, PO_STATUSES.RECEIVED);
    });
  });

  await t.test('INV-05-10: Purchase return cannot exceed received quantity', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const po = await createPurchaseOrder(tx, {
        supplierId: supplierAId,
        locationId: locationAId,
        lines: [{ variantId: variantAId, orderedQty: 10, unitCostCentimes: 600000n }]
      });
      const lineId = po.lines[0].id;

      // Receive 6 units
      await receiveGoods(tx, {
        purchaseOrderId: po.id,
        locationId: locationAId,
        receivedLines: [{ purchaseLineId: lineId, receivedQty: 6 }]
      });

      // Attempt returning 7 units (only 6 received)
      await assert.rejects(
        returnGoodsToSupplier(tx, {
          purchaseOrderId: po.id,
          locationId: locationAId,
          returnLines: [{ purchaseLineId: lineId, returnedQty: 7 }]
        }),
        /Invariant Violation INV-05-10.*exceeds remaining returnable quantity/
      );

      // Return 2 units
      const ret1 = await returnGoodsToSupplier(tx, {
        purchaseOrderId: po.id,
        locationId: locationAId,
        returnLines: [{ purchaseLineId: lineId, returnedQty: 2 }]
      });
      assert.ok(ret1.returnRecord.id);

      // Attempt returning 5 more (2 already returned, 6 received, remaining returnable = 4)
      await assert.rejects(
        returnGoodsToSupplier(tx, {
          purchaseOrderId: po.id,
          locationId: locationAId,
          returnLines: [{ purchaseLineId: lineId, returnedQty: 5 }]
        }),
        /Invariant Violation INV-05-10.*exceeds remaining returnable quantity/
      );
    });
  });

  await t.test('Hostile: Received purchase order cannot transition back to DRAFT or be silently deleted', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const po = await createPurchaseOrder(tx, {
        supplierId: supplierAId,
        locationId: locationAId,
        lines: [{ variantId: variantAId, orderedQty: 5, unitCostCentimes: 600000n }]
      });
      await receiveGoods(tx, {
        purchaseOrderId: po.id,
        locationId: locationAId,
        receivedLines: [{ purchaseLineId: po.lines[0].id, receivedQty: 5 }]
      });

      // 1. Transition back to DRAFT
      await assert.rejects(
        tx.update('purchase_orders', po.id, { status: 'DRAFT' }),
        /Purchase Order Lifecycle Violation.*Cannot transition RECEIVED.*back to 'DRAFT'/
      );

      // 2. Deletion
      await assert.rejects(
        tx.delete('purchase_orders', po.id),
        /Purchase Order Immutability Violation.*Cannot delete purchase order in 'RECEIVED' status/
      );
    });
  });

  await t.test('INV-05-11: Cross-Tenant purchase, receiving, and supplier injection is strictly blocked', async () => {
    // Tenant A attempts to create PO with Tenant B supplier
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      await assert.rejects(
        createPurchaseOrder(tx, {
          supplierId: supplierBId,
          locationId: locationAId,
          lines: [{ variantId: variantAId, orderedQty: 5, unitCostCentimes: 500000n }]
        }),
        /Supplier not found/
      );

      // Tenant A attempts to create PO with Tenant B variant
      await assert.rejects(
        createPurchaseOrder(tx, {
          supplierId: supplierAId,
          locationId: locationAId,
          lines: [{ variantId: variantBId, orderedQty: 5, unitCostCentimes: 500000n }]
        }),
        /Variant not found/
      );
    });

    // Tenant B cannot receive goods for Tenant A PO
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const po = await createPurchaseOrder(tx, {
        supplierId: supplierAId,
        locationId: locationAId,
        lines: [{ variantId: variantAId, orderedQty: 10, unitCostCentimes: 500000n }]
      });

      await db.withTenant({ tenantId: tenantB }, async (txB) => {
        await assert.rejects(
          receiveGoods(txB, {
            purchaseOrderId: po.id,
            locationId: locationBId,
            receivedLines: [{ purchaseLineId: po.lines[0].id, receivedQty: 5 }]
          }),
          /Purchase order not found/
        );
      });
    });
  });

  await t.test('INV-05-13: Failed transaction rolls back completely leaving zero stock or financial mutations', async () => {
    let poId = null;
    let lineId = null;

    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const po = await createPurchaseOrder(tx, {
        supplierId: supplierAId,
        locationId: locationAId,
        lines: [{ variantId: variantAId, orderedQty: 10, unitCostCentimes: 600000n }]
      });
      poId = po.id;
      lineId = po.lines[0].id;
    });

    let stockBefore = 0;
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const lvl = await tx.query('stock_levels', l => l.variant_id === variantAId && l.location_id === locationAId);
      stockBefore = lvl.length > 0 ? lvl[0].on_hand : 0;
    });

    // Attempt receiving with deliberate mid-flight error
    try {
      await db.withTenant({ tenantId: tenantA }, async (tx) => {
        await receiveGoods(tx, {
          purchaseOrderId: poId,
          locationId: locationAId,
          receivedLines: [{ purchaseLineId: lineId, receivedQty: 4 }]
        });
        throw new Error('Simulated hardware/network crash before commit');
      });
    } catch (err) {
      assert.strictEqual(err.message, 'Simulated hardware/network crash before commit');
    }

    // Verify zero mutations committed
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const lvl = await tx.query('stock_levels', l => l.variant_id === variantAId && l.location_id === locationAId);
      const stockAfter = lvl.length > 0 ? lvl[0].on_hand : 0;
      assert.strictEqual(stockAfter, stockBefore, 'INV-05-13: Stock on hand unchanged after rollback');

      const receipts = await tx.query('purchase_receipts', r => r.purchase_order_id === poId);
      assert.strictEqual(receipts.length, 0, 'INV-05-13: Zero purchase receipts recorded after rollback');

      const po = await tx.findById('purchase_orders', poId);
      assert.strictEqual(po.status, PO_STATUSES.ORDERED, 'INV-05-13: PO status remains ORDERED');
    });
  });

  await t.test('RBAC: Cashier role is strictly forbidden from creating POs and receiving goods', async () => {
    assert.throws(
      () => authorize('cashier', PERMISSIONS.PURCHASES_MANAGE),
      /Access Denied: Role 'cashier' lacks required permission 'purchases:manage'/
    );

    assert.throws(
      () => authorize('cashier', PERMISSIONS.PURCHASES_RECEIVE),
      /Access Denied: Role 'cashier' lacks required permission 'purchases:receive'/
    );

    assert.throws(
      () => authorize('cashier', PERMISSIONS.SUPPLIERS_MANAGE),
      /Access Denied: Role 'cashier' lacks required permission 'suppliers:manage'/
    );
  });
});
