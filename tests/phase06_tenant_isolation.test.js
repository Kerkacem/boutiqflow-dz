const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { createOnlineOrder } = require('../src/orders/orders');
const { CodConfirmationService } = require('../src/orders/confirmation_service');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');

test('Phase 06 — Cross-Tenant Isolation & IDOR Penetration Suite (INV-06-11)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let locationAId = null;
  let locationBId = null;
  let variantAId = null;
  let variantBId = null;
  let customerAId = null;
  let customerBId = null;
  let orderAId = null;

  await t.test('Setup isolated tenant environments, customers, variants, and orders', async () => {
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Algiers Hub', type: 'warehouse' });
      locationAId = loc.id;

      const cust = await tx.insert('customers', { name: 'Client Alger', phone: '+213550111111' });
      customerAId = cust.id;

      const prod = await tx.insert('products', { name: 'Pantalon Lin' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'PNT-LIN-WHT-42',
        size: '42',
        color: 'Blanc',
        cost_price: 300000n,
        sale_price: 650000n
      });
      variantAId = v.id;

      await applyStockMovement(tx, {
        variantId: v.id,
        locationId: locationAId,
        qty: 10,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      const order = await createOnlineOrder(tx, {
        customerId: customerAId,
        customerName: 'Client Alger',
        customerPhone: '0550111111',
        items: [{ variantId: variantAId, qty: 2 }]
      });
      orderAId = order.id;

      // Confirm order A
      await CodConfirmationService.confirmAndReserve(tx, {
        orderId: orderAId,
        locationId: locationAId
      });
    });

    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Oran Hub', type: 'warehouse' });
      locationBId = loc.id;

      const cust = await tx.insert('customers', { name: 'Client Oran', phone: '+213660222222' });
      customerBId = cust.id;

      const prod = await tx.insert('products', { name: 'Djellaba Moderne' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'DJL-MOD-BLU-L',
        size: 'L',
        color: 'Bleu',
        cost_price: 400000n,
        sale_price: 850000n
      });
      variantBId = v.id;

      await applyStockMovement(tx, {
        variantId: v.id,
        locationId: locationBId,
        qty: 10,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });
  });

  await t.test('INV-06-11: IDOR Attack: Tenant B direct lookup of Tenant A order returns null', async () => {
    await db.withTenant({ tenantId: tenantB }, async (txB) => {
      const order = await txB.findById('online_orders', orderAId);
      assert.strictEqual(order, null, 'INV-06-11: Cross-tenant direct order lookup returns null');

      const items = await txB.query('order_items', i => i.order_id === orderAId);
      assert.strictEqual(items.length, 0, 'INV-06-11: Cross-tenant order items query returns empty');
    });
  });

  await t.test('INV-06-11: Cross-tenant confirmation attempt is strictly rejected', async () => {
    await db.withTenant({ tenantId: tenantB }, async (txB) => {
      await assert.rejects(
        CodConfirmationService.confirmAndReserve(txB, {
          orderId: orderAId,
          locationId: locationBId
        }),
        /Order .* not found/
      );
    });
  });

  await t.test('INV-06-11: Cross-tenant cancellation attempt is strictly rejected', async () => {
    await db.withTenant({ tenantId: tenantB }, async (txB) => {
      await assert.rejects(
        CodConfirmationService.cancelAndRelease(txB, {
          orderId: orderAId,
          reason: 'Malicious cancel'
        }),
        /Order .* not found/
      );
    });
  });

  await t.test('INV-06-11: Order creation referencing foreign tenant variant is rejected', async () => {
    // Tenant B attempts to order Tenant A's variant
    await db.withTenant({ tenantId: tenantB }, async (txB) => {
      await assert.rejects(
        createOnlineOrder(txB, {
          customerName: 'Hacker',
          customerPhone: '0660222222',
          items: [{ variantId: variantAId, qty: 1 }]
        }),
        /Variant not found/
      );
    });
  });

  await t.test('INV-06-11: Tenant B cannot inspect or release Tenant A stock reservations', async () => {
    await db.withTenant({ tenantId: tenantB }, async (txB) => {
      const reservations = await txB.query('stock_reservations', r => r.order_id === orderAId);
      assert.strictEqual(reservations.length, 0, 'Tenant B cannot see Tenant A reservations');
    });
  });

  await t.test('Security: Forged tenant_id in order insertion payload throws Security Violation', async () => {
    await db.withTenant({ tenantId: tenantA }, async (txA) => {
      await assert.rejects(
        txA.insert('online_orders', {
          tenant_id: tenantB, // Forging Tenant B ID
          order_number: 'CMD-FORGED',
          customer_phone: '+213550111111'
        }),
        /Security Violation: Cannot insert row for tenant/
      );
    });
  });
});
