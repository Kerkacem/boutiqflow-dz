const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  ORDER_STATUSES,
  createOnlineOrder
} = require('../src/orders/orders');
const { CodConfirmationService, CONFIRMATION_STATUSES } = require('../src/orders/confirmation_service');
const { applyStockMovement, getOrCreateStockLevel, MOVEMENT_REASONS } = require('../src/inventory/ledger');

test('Phase 06 — COD Hostile & Boundary Attack Suite', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let locationId = null;
  let variantId = null;

  await t.test('Setup tenant, store location, and test variant stock', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Algiers Depot', type: 'warehouse' });
      locationId = loc.id;

      const prod = await tx.insert('products', { name: 'Robe Caftan' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'CFT-ROB-EMR-40',
        size: '40',
        color: 'Emeraude',
        cost_price: 500000n,
        sale_price: 1100000n
      });
      variantId = v.id;

      // Seed exactly 1 unit of stock
      await applyStockMovement(tx, {
        variantId: v.id,
        locationId,
        qty: 1,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });
  });

  await t.test('Hostile: Negative quantity, zero quantity, and decimal quantity rejected', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Negative quantity
      await assert.rejects(
        createOnlineOrder(tx, {
          customerName: 'Amina',
          customerPhone: '0550112233',
          items: [{ variantId, qty: -2 }]
        }),
        /Validation Error.*strictly positive integer/
      );

      // 2. Zero quantity
      await assert.rejects(
        createOnlineOrder(tx, {
          customerName: 'Amina',
          customerPhone: '0550112233',
          items: [{ variantId, qty: 0 }]
        }),
        /Validation Error.*strictly positive integer/
      );

      // 3. Decimal quantity
      await assert.rejects(
        createOnlineOrder(tx, {
          customerName: 'Amina',
          customerPhone: '0550112233',
          items: [{ variantId, qty: 1.5 }]
        }),
        /Validation Error.*strictly positive integer/
      );

      // 4. Empty items array
      await assert.rejects(
        createOnlineOrder(tx, {
          customerName: 'Amina',
          customerPhone: '0550112233',
          items: []
        }),
        /Validation Error.*at least one line item/
      );

      // 5. Negative unit price
      await assert.rejects(
        createOnlineOrder(tx, {
          customerName: 'Amina',
          customerPhone: '0550112233',
          items: [{ variantId, qty: 1, unitPriceCentimes: -500n }]
        }),
        /Validation Error.*Unit price cannot be negative/
      );
    });
  });

  await t.test('Hostile: Invalid Algerian phone numbers rejected & valid phone numbers normalized', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Invalid formats
      const invalidPhones = ['12345', 'abcdef', '044123456', '+33612345678', ''];
      for (const phone of invalidPhones) {
        await assert.rejects(
          createOnlineOrder(tx, {
            customerName: 'Test Phone',
            customerPhone: phone,
            items: [{ variantId, qty: 1 }]
          }),
          /Validation Error|Invalid Algerian phone number/
        );
      }

      // 2. Valid formats properly normalized to +213XXXXXXXXX
      const validCases = [
        { input: '0550123456', expected: '+213550123456' },
        { input: '+213661234567', expected: '+213661234567' },
        { input: '00213770123456', expected: '+213770123456' }
      ];

      for (const { input, expected } of validCases) {
        const order = await createOnlineOrder(tx, {
          customerName: 'Normal Test',
          customerPhone: input,
          items: [{ variantId, qty: 1 }]
        });
        assert.strictEqual(order.customer_phone, expected);
        assert.strictEqual(order.customer_snapshot.phoneNormalized, expected);
      }
    });
  });

  await t.test('INV-06-16: Stock unavailable rejects confirmation with zero partial reservations', async () => {
    let orderId = null;
    await db.withTenant({ tenantId }, async (tx) => {
      // Current stock on hand is 1. Customer orders 3 units!
      const order = await createOnlineOrder(tx, {
        customerName: 'Rachid Mebarki',
        customerPhone: '0555667788',
        items: [{ variantId, qty: 3 }]
      });
      orderId = order.id;
    });

    await db.withTenant({ tenantId }, async (tx) => {
      // Confirmation must fail and leave zero partial reservations
      await assert.rejects(
        CodConfirmationService.confirmAndReserve(tx, {
          orderId,
          locationId
        }),
        /Invariant Violation INV-06-16.*Insufficient stock.*No partial reservation created/
      );

      // Verify order status is marked STOCK_UNAVAILABLE
      const order = await tx.findById('online_orders', orderId);
      assert.strictEqual(order.status, CONFIRMATION_STATUSES.STOCK_UNAVAILABLE);

      // Verify ZERO reservations exist for this order
      const reservations = await tx.query('stock_reservations', r => r.order_id === orderId);
      assert.strictEqual(reservations.length, 0, 'INV-06-16: Zero partial reservations created');

      // Verify available stock is still 1 (not depleted)
      const level = await getOrCreateStockLevel(tx, variantId, locationId);
      assert.strictEqual(level.on_hand, 1);
      assert.strictEqual(level.reserved, 0);
      assert.strictEqual(level.available, 1);
    });
  });

  await t.test('Hostile: Confirmation of non-existent or cancelled/refused order rejected', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Non-existent order
      await assert.rejects(
        CodConfirmationService.confirmAndReserve(tx, {
          orderId: generateUUIDv7(),
          locationId
        }),
        /Order .* not found/
      );

      // 2. Order cancelled
      const order = await createOnlineOrder(tx, {
        customerName: 'Yacine',
        customerPhone: '0660112233',
        items: [{ variantId, qty: 1 }]
      });
      await CodConfirmationService.cancelAndRelease(tx, { orderId: order.id, reason: 'Customer changed mind' });

      await assert.rejects(
        CodConfirmationService.confirmAndReserve(tx, {
          orderId: order.id,
          locationId
        }),
        /Cannot confirm an order that is in status 'CANCELLED'/
      );
    });
  });

  await t.test('INV-06-08: Client cannot forge calculated order totals, delivery fees, or COD amounts', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Subtotal = 2 * 11,000 DA = 22,000 DA (2,200,000 centimes)
      // Delivery fee = 500 DA (50,000 centimes)
      // Discount = 1,000 DA (100,000 centimes)
      // Server-calculated total = 2,200,000 + 50,000 - 100,000 = 2,150,000 centimes (21,500 DA)
      const order = await createOnlineOrder(tx, {
        customerName: 'Karima',
        customerPhone: '0555998877',
        deliveryFeeCentimes: 50000n,
        discountCentimes: 100000n,
        items: [{ variantId, qty: 2, unitPriceCentimes: 1100000n }]
      });

      assert.strictEqual(order.subtotal_centimes, 2200000n);
      assert.strictEqual(order.delivery_fee_centimes, 50000n);
      assert.strictEqual(order.discount_centimes, 100000n);
      assert.strictEqual(order.total_centimes, 2150000n);
      assert.strictEqual(order.cod_amount_centimes, 2150000n, 'COD amount strictly calculated by server');
    });
  });
});
