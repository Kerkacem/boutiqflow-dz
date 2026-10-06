const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  IntegrationOutboxService,
  OUTBOX_STATUSES
} = require('../src/integrations');

test('Phase 10 — Critical Outbox & Two-Phase Crash Resilience (INV-10-08, INV-10-09, Critical Test 51)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const integrationId = generateUUIDv7();

  await t.test('1. Two-phase failure test: Local sale commits, Shopify returns 500 -> Sale COMPLETE, Outbox RETRYABLE_FAILURE (INV-10-08)', async () => {
    let outboxItem = null;

    // Phase 1: Local transaction commits sale and enqueues outbox event
    await db.withTenant({ tenantId }, async (tx) => {
      // Simulate committed local sale
      const sale = await tx.insert('sales', {
        id: generateUUIDv7(),
        total_cents: 1000000n,
        status: 'COMPLETED'
      });

      outboxItem = await IntegrationOutboxService.enqueue(tx, {
        integrationId,
        eventType: 'SALE_COMPLETED',
        aggregateType: 'SALE',
        aggregateId: sale.id,
        payload: { saleId: sale.id, total: 10000 }
      });

      assert.strictEqual(outboxItem.status, OUTBOX_STATUSES.QUEUED);
    });

    // Phase 2: Worker processes outbox item, external API throws 500 error
    await db.withTenant({ tenantId }, async (tx) => {
      const processed = await IntegrationOutboxService.processItem(tx, {
        itemId: outboxItem.id,
        externalApiCaller: async () => {
          const err = new Error('Shopify 500 Internal Server Error');
          err.code = 'SHOPIFY_500';
          throw err;
        }
      });

      assert.strictEqual(processed.status, OUTBOX_STATUSES.RETRYABLE_FAILURE);
      assert.strictEqual(processed.last_error.code, 'SHOPIFY_500');

      // Crucial Assertion: Local sale was NOT rolled back
      const sales = await tx.query('sales', () => true);
      assert.strictEqual(sales.length, 1);
      assert.strictEqual(sales[0].status, 'COMPLETED', 'Committed local sale must NEVER rollback on external API error (INV-10-08)');
    });
  });

  await t.test('2. Critical Test 51: Worker crash after external success -> lookup recovery prevents duplicate effect (INV-10-09)', async () => {
    let outboxItem = null;
    let externalCallCount = 0;

    await db.withTenant({ tenantId }, async (tx) => {
      outboxItem = await IntegrationOutboxService.enqueue(tx, {
        integrationId,
        eventType: 'FULFILLMENT_CREATED',
        aggregateType: 'SHIPMENT',
        aggregateId: 'shp_123',
        payload: { trackingNumber: 'YAL-998877' }
      });
    });

    // Step A: First run succeeds remotely at external platform, but worker crashes before marking DELIVERED locally
    const remoteCreatedStore = new Set();

    try {
      await db.withTenant({ tenantId }, async (tx) => {
        await IntegrationOutboxService.processItem(tx, {
          itemId: outboxItem.id,
          externalApiCaller: async (item) => {
            externalCallCount++;
            remoteCreatedStore.add(item.payload.trackingNumber);
            throw new Error('WORKER_CRASHED_BEFORE_DELIVERED_UPDATE');
          }
        });
      });
    } catch {
      // Worker crashed
    }

    assert.strictEqual(externalCallCount, 1);
    assert.strictEqual(remoteCreatedStore.has('YAL-998877'), true);

    // Step B: Worker restarts. It uses externalResourceLookup to check if remote effect already took place
    await db.withTenant({ tenantId }, async (tx) => {
      const recovered = await IntegrationOutboxService.processItem(tx, {
        itemId: outboxItem.id,
        externalResourceLookup: async (item) => {
          return remoteCreatedStore.has(item.payload.trackingNumber);
        },
        externalApiCaller: async () => {
          externalCallCount++;
          return { success: true };
        }
      });

      assert.strictEqual(recovered.status, OUTBOX_STATUSES.DELIVERED);
      assert.strictEqual(recovered.recovered_from_crash, true);
      assert.strictEqual(externalCallCount, 1, 'MUST NOT call external API again (0 duplicate remote calls)');
    });
  });
});
