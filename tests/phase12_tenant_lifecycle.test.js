const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  TenantLifecycleService,
  SubscriptionService,
  TENANT_LIFECYCLE_STATES,
  SUBSCRIPTION_STATUSES,
  BILLING_ERRORS
} = require('../src/billing');

test('Phase 12 — Tenant Lifecycle, Read-Only & Suspension Policies (INV-12-14, INV-12-15, Critical Tests 61 & 62)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Critical Test 61: Suspended tenant cannot perform unauthorized mutations (INV-12-14)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Create subscription in SUSPENDED
      const sub = await SubscriptionService.createSubscription(tx, {
        tenantId,
        status: SUBSCRIPTION_STATUSES.SUSPENDED
      });
      await TenantLifecycleService.transitionLifecycle(tx, tenantId, TENANT_LIFECYCLE_STATES.SUSPENDED, 'Past due grace expired');

      // Attempting mutation in suspended state throws SUBSCRIPTION_SUSPENDED
      assert.throws(
        () => SubscriptionService.assertMutationAllowed(sub),
        (err) => {
          assert.strictEqual(err.code, BILLING_ERRORS.SUBSCRIPTION_SUSPENDED);
          return true;
        }
      );

      assert.throws(
        () => TenantLifecycleService.assertOperationAllowed(TENANT_LIFECYCLE_STATES.SUSPENDED, 'POST_SALE'),
        (err) => {
          assert.strictEqual(err.code, BILLING_ERRORS.SUBSCRIPTION_SUSPENDED);
          return true;
        }
      );
    });
  });

  await t.test('2. Critical Test 62: Read-Only mode allows GET/EXPORT but blocks POST mutations (INV-12-14)', async () => {
    // Operations in READ_ONLY:
    // Permitted: GET, READ, EXPORT, VIEW_REPORTS, VIEW_INVOICES
    assert.doesNotThrow(() => {
      TenantLifecycleService.assertOperationAllowed(TENANT_LIFECYCLE_STATES.READ_ONLY, 'GET');
      TenantLifecycleService.assertOperationAllowed(TENANT_LIFECYCLE_STATES.READ_ONLY, 'EXPORT');
      TenantLifecycleService.assertOperationAllowed(TENANT_LIFECYCLE_STATES.READ_ONLY, 'VIEW_REPORTS');
    });

    // Blocked: POST_SALE, POST_PURCHASE, POST_USER, POST_INTEGRATION
    const blockedMutations = ['POST_SALE', 'POST_PURCHASE', 'POST_USER', 'POST_INTEGRATION'];
    for (const op of blockedMutations) {
      assert.throws(
        () => TenantLifecycleService.assertOperationAllowed(TENANT_LIFECYCLE_STATES.READ_ONLY, op),
        (err) => {
          assert.strictEqual(err.code, BILLING_ERRORS.SUBSCRIPTION_READ_ONLY);
          return true;
        }
      );
    }
  });

  await t.test('3. Invariant INV-12-15: Billing suspension does NOT delete operational data', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Create operational product and customer
      const cat = await tx.insert('categories', { name: 'Robes' });
      const brand = await tx.insert('brands', { name: 'Maison DZ' });
      const product = await tx.insert('products', {
        name: 'Robe Karakou',
        category_id: cat.id,
        brand_id: brand.id
      });
      const customer = await tx.insert('customers', {
        first_name: 'Amina',
        last_name: 'Benali',
        phone: '0555000111'
      });

      // Suspend tenant
      await TenantLifecycleService.transitionLifecycle(tx, tenantId, TENANT_LIFECYCLE_STATES.SUSPENDED, 'Non-payment');

      // Verify operational data remains fully intact in database
      const fetchedProduct = await tx.findById('products', product.id);
      assert.ok(fetchedProduct);
      assert.strictEqual(fetchedProduct.name, 'Robe Karakou');

      const fetchedCustomer = await tx.findById('customers', customer.id);
      assert.ok(fetchedCustomer);
      assert.strictEqual(fetchedCustomer.first_name, 'Amina');
    });
  });
});
