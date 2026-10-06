const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { createOnlineOrder } = require('../src/orders/orders');
const { DataMaskingService } = require('../src/compliance/data_masking');
const { ProcessingJournalService, PROCESSING_OPERATIONS } = require('../src/compliance/processing_journal');
const { ROLES } = require('../src/rbac/permissions');

test('Phase 06 — Customer PII Protection, Masking & Processing Journal Suite', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let variantId = null;
  let customerId = null;

  await t.test('Setup customer, product, and variant', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const cust = await tx.insert('customers', {
        name: 'Amina Mansouri',
        phone: '+213555987654',
        address: '14 Rue Didouche Mourad, Alger Centre',
        wilaya: '16 - Alger'
      });
      customerId = cust.id;

      const prod = await tx.insert('products', { name: 'Foulard Soie' });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'FLD-SOIE-BLU',
        size: 'TU',
        color: 'Bleu',
        cost_price: 100000n,
        sale_price: 250000n
      });
      variantId = v.id;
    });
  });

  await t.test('Customer snapshot permanence: Modifying live customer profile does not mutate old order snapshot', async () => {
    let orderId = null;
    await db.withTenant({ tenantId }, async (tx) => {
      const order = await createOnlineOrder(tx, {
        customerId,
        customerName: 'Amina Mansouri',
        customerPhone: '0555987654',
        wilaya: '16 - Alger',
        commune: 'Alger Centre',
        address: '14 Rue Didouche Mourad',
        items: [{ variantId, qty: 1 }]
      });
      orderId = order.id;

      assert.strictEqual(order.customer_snapshot.address, '14 Rue Didouche Mourad');
      assert.strictEqual(order.customer_snapshot.phoneNormalized, '+213555987654');
    });

    // Customer changes their phone and moves to Oran
    await db.withTenant({ tenantId }, async (tx) => {
      await tx.update('customers', customerId, {
        phone: '+213770112233',
        address: 'Nouvelle adresse, Oran'
      });
    });

    // Historical order customer snapshot remains intact
    await db.withTenant({ tenantId }, async (tx) => {
      const order = await tx.findById('online_orders', orderId);
      assert.strictEqual(
        order.customer_snapshot.address,
        '14 Rue Didouche Mourad',
        'Historical order address snapshot remains permanently unchanged'
      );
      assert.strictEqual(
        order.customer_snapshot.phoneNormalized,
        '+213555987654',
        'Historical order phone snapshot remains permanently unchanged'
      );
    });
  });

  await t.test('Role-based PII Masking: Cashier and Stock Clerk see masked contact data', async () => {
    const rawCustomer = {
      id: customerId,
      name: 'Amina Mansouri',
      phone: '+213555987654',
      address: '14 Rue Didouche Mourad, Alger Centre'
    };

    // 1. Masking for Cashier
    const cashierView = DataMaskingService.sanitizeCustomerForRole(rawCustomer, ROLES.CASHIER.toUpperCase());
    assert.strictEqual(cashierView.phone, '+213 555 *** *54', 'Phone is masked for cashier');
    assert.strictEqual(cashierView.address.includes('محجوب للكاشير'), true, 'Address is hidden from cashier');

    // 2. Masking for Stock Clerk / Manager
    const stockView = DataMaskingService.sanitizeCustomerForRole(rawCustomer, 'STOCK_MANAGER');
    assert.strictEqual(stockView.phone, '+213 555 *** *54');
    assert.strictEqual(stockView.address, undefined, 'Address omitted from stock manager');

    // 3. Full access for Owner / Manager
    const managerView = DataMaskingService.sanitizeCustomerForRole(rawCustomer, 'MANAGER');
    assert.strictEqual(managerView.phone, '+213555987654', 'Full phone for manager');
    assert.strictEqual(managerView.address, '14 Rue Didouche Mourad, Alger Centre', 'Full address for manager');
  });

  await t.test('INV-06-13: Personal Data Processing Journal logs compliance events and is strictly append-only', async () => {
    let journalEntryId = null;

    await db.withTenant({ tenantId }, async (tx) => {
      // 1. Check order creation logged collection
      const journalEntries = await ProcessingJournalService.queryJournal(tx, {
        operation: PROCESSING_OPERATIONS.COLLECTION
      });
      assert.ok(journalEntries.length > 0, 'INV-06-13: COLLECTION operation was logged in processing journal');

      // 2. Log consultation when manager views unmasked customer
      const entry = await ProcessingJournalService.logOperation(tx, {
        actorId: generateUUIDv7(),
        actorRole: 'MANAGER',
        operation: PROCESSING_OPERATIONS.CONSULTATION,
        dataSubjectType: 'CUSTOMER',
        dataSubjectId: customerId,
        purpose: 'DELIVERY_DISPATCH'
      });
      assert.ok(entry.id);
      journalEntryId = entry.id;
    });

    // 3. Attempt to update or delete processing journal entry (INV-06-12)
    await db.withTenant({ tenantId }, async (tx) => {
      await assert.rejects(
        tx.update('processing_journal', journalEntryId, { purpose: 'ILLEGAL_ALTERATION' }),
        /Audit Trail Violation.*processing_journal records are strictly immutable/
      );

      await assert.rejects(
        tx.delete('processing_journal', journalEntryId),
        /Audit Trail Violation.*processing_journal records cannot be deleted/
      );
    });
  });
});
