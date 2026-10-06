const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const {
  LocalOutbox,
  SyncEngine,
  DeviceService,
  OfflineReceiptEngine,
  OFFLINE_OPERATIONS,
  OUTBOX_STATUSES
} = require('../src/offline');

test('Phase 08 — Offline Receipt & Deduplicated Sync Suite (INV-04-13, INV-08-18, Requirement 23)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  const deviceId = `POS-RCPT-${generateUUIDv7()}`;

  let locationId = null;
  let cashierId = null;
  let variantId = null;
  let sessionId = null;
  let registerId = null;

  await t.test('Setup server state: register, cashier, session, and variant stock', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Bejaia', type: 'shop' });
      locationId = loc.id;

      const user = await tx.insert('users', {
        name: 'Nadia Cashier',
        email: 'nadia@boutiqflow.dz',
        role: 'cashier',
        password_hash: 'hash'
      });
      cashierId = user.id;

      const reg = await tx.insert('cash_registers', { name: 'Caisse Bejaia 1', location_id: locationId });
      registerId = reg.id;

      const sess = await tx.insert('register_sessions', {
        register_id: reg.id,
        cashier_id: cashierId,
        opening_float_centimes: 1000000n,
        status: 'OPEN'
      });
      sessionId = sess.id;

      await DeviceService.registerDevice(tx, {
        registerId: reg.id,
        name: 'POS Terminal Bejaia',
        deviceId
      });

      const prod = await tx.insert('products', { name: 'Jupe Plissée' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'JUP-PLI-NOIR-38',
        size: '38',
        color: 'Noir',
        cost_price: 150000n,
        sale_price: 350000n // 3,500 DA
      });
      variantId = variant.id;

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: locationId,
        quantity: 10,
        qty: 10,
        movementType: 'IN',
        costPriceCentimes: 150000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });
    });
  });

  await t.test('Requirement 23 & INV-08-18: Offline sale -> Print receipt -> Reconnect -> Sync x 20 -> 1 Sale, 1 Inventory, 1 Cash, 1 Receipt mapping', async () => {
    // 1. Cashier performs offline sale
    const outbox = new LocalOutbox({ deviceId, tenantId });
    const op = outbox.enqueueOperation({
      operationType: OFFLINE_OPERATIONS.POS_SALE,
      payload: {
        sessionId,
        registerId,
        locationId,
        cashierId,
        items: [{ variantId, quantity: 1, unitPriceCentimes: 350000n }],
        payments: [{ tenderType: 'CASH', amountCentimes: 350000n }]
      }
    });

    // 2. Local receipt is printed offline with LOCAL/PENDING mark
    const localReceipt = OfflineReceiptEngine.renderOfflineReceipt({
      storeName: 'Boutique Bejaia',
      registerId,
      cashierName: 'Nadia',
      items: [{ name: 'Jupe Plissée (38, Noir)', qty: 1, unitPriceCentimes: 350000n }],
      payments: [{ tenderType: 'CASH', amountCentimes: 350000n }],
      totalCentimes: 350000n,
      operationId: op.operationId
    });

    assert.ok(localReceipt.localReceiptId.startsWith('OFFLINE-'), 'Local receipt ID generated');
    assert.strictEqual(localReceipt.isPendingSync, true);
    assert.ok(localReceipt.ticketText.includes('EN ATTENTE DE SYNCHRO'), 'Receipt explicitly marked as pending sync');

    // 3. Reconnect -> Sync with Server -> Response timeout -> Retry x 20
    let serverReceiptMap = null;

    for (let i = 0; i < 20; i++) {
      await db.withTenant({ tenantId }, async (tx) => {
        const syncRes = await SyncEngine.syncBatch(tx, {
          deviceId,
          operations: [op]
        });

        assert.strictEqual(syncRes.success, true);
        const ack = syncRes.acknowledgements[0];
        assert.strictEqual(ack.status, OUTBOX_STATUSES.ACKED);

        if (i === 0) {
          // Map local ticket to official server sale
          serverReceiptMap = OfflineReceiptEngine.mapToServerSale({
            localReceiptId: localReceipt.localReceiptId,
            serverReceiptNumber: ack.serverReference,
            serverSaleId: ack.result.saleId
          });
        }
      });
    }

    assert.strictEqual(serverReceiptMap.isPendingSync, false);
    assert.ok(serverReceiptMap.serverReceiptNumber, 'Official server receipt number mapped');

    // 4. Strict Single Business Effect Verification (INV-08-18):
    await db.withTenant({ tenantId }, async (tx) => {
      // 1 Sale in database
      const sales = await tx.query('sales', s => s.tenant_id === tenantId);
      assert.strictEqual(sales.length, 1, 'Exactly 1 sale created in database');

      // 1 Inventory sale movement
      const movements = await tx.query('stock_movements', sm => sm.reference_type === 'SALE_RECEIPT' || sm.reason === MOVEMENT_REASONS.POS_SALE);
      assert.strictEqual(movements.length, 1, 'Exactly 1 inventory sale movement recorded');
      assert.strictEqual(movements[0].qty, -1);

      // 1 Cash payment movement
      const cashTx = await tx.query('cash_transactions', ct => ct.type === 'SALE_CASH');
      assert.strictEqual(cashTx.length, 1, 'Exactly 1 cash movement recorded');
      assert.strictEqual(cashTx[0].amount_centimes, 350000n);

      // 1 Processed operation
      const processed = await tx.query('processed_operations', p => p.tenant_id === tenantId);
      assert.strictEqual(processed.length, 1, 'Exactly 1 processed_operations record exists');
    });
  });
});
