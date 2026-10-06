const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { receiveStock, getVariantStock } = require('../src/inventory/ledger');
const { PaymentService, SubscriptionService, SUBSCRIPTION_STATUSES } = require('../src/billing');
const {
  BackupRecoveryService,
  IntegrityCheckJob,
  INTEGRITY_STATUSES
} = require('../src/security');

test('Phase 13 — Composite Full-Stack Chaos & Resilience Milestone (INV-13-01 to INV-13-30, Requirement 103)', async (t) => {
  const db = new MahalDatabase();
  const tenantA = generateUUIDv7();
  const tenantB = generateUUIDv7();

  let locationA;
  let variantA;

  await t.test('Full-Stack Chaos: Seed -> Baseline Backup -> Traffic Spike -> Failures -> Restore -> Full Verify (Requirement 103)', async () => {
    // 1. SEED MULTI-TENANT STATE
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Products & Inventory
      const loc = await tx.insert('inventory_locations', { name: 'Shop Alger Centre' });
      locationA = loc.id;
      const cat = await tx.insert('categories', { name: 'Robes Traditionnelles' });
      const prod = await tx.insert('products', { name: 'Karakou Brode', category_id: cat.id });
      const v = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'KAR-01',
        sale_price: 3500000n,
        cost_price: 1500000n
      });
      variantA = v.id;

      await receiveStock(tx, {
        tenantId: tenantA,
        locationId: locationA,
        variantId: variantA,
        quantity: 25,
        unitCostCentimes: 1500000n,
        operationId: 'CHAOS-SEED-STOCK'
      });

      // Active Subscription on PRO_V1
      await SubscriptionService.createSubscription(tx, {
        tenantId: tenantA,
        planVersionId: 'PRO_V1',
        status: SUBSCRIPTION_STATUSES.ACTIVE
      });
    });

    await db.withTenant({ tenantId: tenantB }, async (tx) => {
      await tx.insert('products', { name: 'Tenant B Exclusive Abaya' });
      await SubscriptionService.createSubscription(tx, {
        tenantId: tenantB,
        planVersionId: 'STARTER_V1',
        status: SUBSCRIPTION_STATUSES.ACTIVE
      });
    });

    // 2. CAPTURE HEALTHY BASELINE BACKUP WITH RECOVERY MARKER
    const baselineBackup = BackupRecoveryService.createBackup(db, {
      backupType: 'FULL',
      marker: 'BASELINE_CHECKPOINT_CLEAN'
    });
    assert.ok(baselineBackup.checksum);

    // 3. CHAOS STAGE 1: API Spike & Webhook Replays x 20
    await db.withTenant({ tenantId: tenantA }, async (tx) => {
      // Create invoice
      const inv = await tx.insert('invoices', {
        id: generateUUIDv7(),
        tenant_id: tenantA,
        invoice_number: 'BF-2026-CHAOS-001',
        total_cents: 299000n,
        currency: 'DZD',
        status: 'ISSUED'
      });

      // 20 repeated webhooks
      for (let i = 0; i < 20; i++) {
        await PaymentService.processPaymentWebhook(tx, {
          provider: 'CHARGILY',
          externalEventId: 'CHAOS-WH-777',
          payload: {
            invoiceId: inv.id,
            amountCents: 299000n,
            currency: 'DZD'
          }
        });
      }

      // Exactly 1 payment recorded
      const payments = await tx.query('payments', p => p.invoice_id === inv.id);
      assert.strictEqual(payments.length, 1);
    });

    // 4. CHAOS STAGE 2: Database Transient Failure & Worker Crash Mid-Transaction
    try {
      await db.withTenant({ tenantId: tenantA }, async (tx) => {
        await tx.insert('sales', {
          id: generateUUIDv7(),
          status: 'PENDING',
          total_centimes: 1000000n
        });
        // Sudden simulated process kill
        throw new Error('WORKER_SIGKILL_CHAOS');
      });
    } catch (e) {
      assert.strictEqual(e.message, 'WORKER_SIGKILL_CHAOS');
    }

    // 5. CHAOS STAGE 3: Synthetic Destructive Corruption (Ransomware-like mass modification)
    const corruptReport = BackupRecoveryService.simulateDestructiveWipe(db, {
      corruptOnlyTargetTables: ['products', 'sales']
    });
    assert.ok(corruptReport.corruptedTables.length > 0);

    // 6. CHAOS STAGE 4: Detection & Disaster Recovery
    // Checksum verification and restore from clean baseline
    const recoveredDb = new MahalDatabase();
    const restoreRes = BackupRecoveryService.restoreSnapshot(baselineBackup, recoveredDb);
    assert.strictEqual(restoreRes.status, 'RESTORE_SUCCESS');

    // 7. COMPREHENSIVE FINAL ASSERTION: Zero Cross-Tenant Leak, Zero Data Corruption, Zero Negative Stock
    await recoveredDb.withTenant({ tenantId: tenantA }, async (tx) => {
      // 0 Negative Stock
      const stock = await getVariantStock(tx, variantA, locationA);
      assert.strictEqual(stock.onHand, 25);
      assert.strictEqual(stock.reserved, 0);
      assert.strictEqual(stock.available, 25);
      assert.ok(stock.onHand >= 0);

      // 0 Cross-Tenant Leakage (Tenant A cannot see Tenant B product)
      const bProds = await tx.query('products', p => p.name === 'Tenant B Exclusive Abaya');
      assert.strictEqual(bProds.length, 0);

      // 0 Corruption in restored products
      const prodA = await tx.query('products', p => p.name === 'Karakou Brode');
      assert.strictEqual(prodA.length, 1);
      assert.strictEqual(prodA[0].corrupted, undefined);

      // Data Integrity Check Job reports MATCHED
      const audit = await IntegrityCheckJob.runAllChecks(tx, tenantA);
      assert.strictEqual(audit.overallStatus, INTEGRITY_STATUSES.MATCHED);
      assert.strictEqual(audit.discrepanciesCount, 0);
    });
  });
});
