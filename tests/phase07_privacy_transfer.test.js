const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const { createOnlineOrder } = require('../src/orders/orders');
const { CodConfirmationService } = require('../src/orders/confirmation_service');
const { applyStockMovement, MOVEMENT_REASONS } = require('../src/inventory/ledger');
const {
  ShipmentService,
  GenericDeliveryProvider,
  encryptCredentials,
  decryptCredentials,
  maskCredentials,
  DELIVERY_PROVIDERS
} = require('../src/delivery');

test('Phase 07 — Privacy Compliance, Transfer Records & Credential Security Suite (INV-07-07, INV-07-15, INV-07-16)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  let locationId = null;
  let variantId = null;
  let orderId = null;

  await t.test('Setup tenant order and confirmed reservation', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Dépôt Alger Centre', type: 'shop' });
      locationId = loc.id;

      const prod = await tx.insert('products', { name: 'Gourmette Argent' });
      const variant = await tx.insert('product_variants', {
        product_id: prod.id,
        sku: 'GOR-ARG-925',
        size: 'Unique',
        color: 'Argent',
        cost_price: 200000n,
        sale_price: 450000n
      });
      variantId = variant.id;

      await applyStockMovement(tx, {
        variantId: variant.id,
        locationId: locationId,
        quantity: 10,
        movementType: 'IN',
        costPriceCentimes: 200000n,
        reason: MOVEMENT_REASONS.RECEIVING
      });

      const ord = await createOnlineOrder(tx, {
        customerName: 'Leila Khemis',
        customerPhone: '0555998877',
        wilaya: 'Alger',
        commune: 'Bab El Oued',
        address: 'Rue Colonel Lotfi',
        items: [{ variantId: variant.id, quantity: 1 }]
      });
      await CodConfirmationService.confirmAndReserve(tx, { orderId: ord.id, locationId });
      orderId = ord.id;
    });
  });

  await t.test('INV-07-15: Shipment creation automatically logs PERSONAL_DATA_TRANSMITTED to Processing Journal', async () => {
    let shipment = null;
    await db.withTenant({ tenantId }, async (tx) => {
      shipment = await ShipmentService.createShipment(tx, {
        orderId,
        provider: DELIVERY_PROVIDERS.YALIDINE,
        actorId: 'usr-agent-01'
      });
    });

    await db.withTenant({ tenantId }, async (tx) => {
      const journalLogs = await tx.query('processing_journal', j =>
        j.tenant_id === tenantId &&
        j.action === 'PERSONAL_DATA_TRANSMITTED' &&
        j.shipment_id === shipment.id
      );

      assert.strictEqual(journalLogs.length, 1, 'Exactly one data transmission journal record logged');
      const log = journalLogs[0];
      assert.strictEqual(log.purpose, 'DELIVERY_FULFILLMENT');
      assert.strictEqual(log.provider, 'YALIDINE');
      assert.strictEqual(log.actor_id, 'usr-agent-01');
      assert.ok(log.data_categories.includes('recipient_name'));
      assert.ok(log.data_categories.includes('recipient_phone'));
      assert.ok(log.data_categories.includes('recipient_address'));

      // Verify processing journal is append-only
      await assert.rejects(
        async () => {
          await tx.update('processing_journal', log.id, { purpose: 'MODIFIED' });
        },
        /Audit Trail Violation: processing_journal records are strictly immutable and append-only/
      );

      await assert.rejects(
        async () => {
          await tx.delete('processing_journal', log.id);
        },
        /Audit Trail Violation: processing_journal records cannot be deleted/
      );
    });
  });

  await t.test('INV-07-15: Cross-Border Carrier Integration generates statutory TransferRecord', async () => {
    let order2 = null;
    await db.withTenant({ tenantId }, async (tx) => {
      order2 = await createOnlineOrder(tx, {
        customerName: 'Chafik M.',
        customerPhone: '0661998877',
        wilaya: 'Oran',
        commune: 'Oran',
        address: 'Front de mer',
        items: [{ variantId, quantity: 1 }]
      });
      await CodConfirmationService.confirmAndReserve(tx, { orderId: order2.id, locationId });
    });

    const crossBorderAdapter = new GenericDeliveryProvider({
      id: 'acc-dhl-global',
      provider: 'DHL_GLOBAL',
      baseUrl: 'https://api.dhl-global.com/v1',
      isCrossBorder: true
    });

    let shipment2 = null;
    await db.withTenant({ tenantId }, async (tx) => {
      shipment2 = await ShipmentService.createShipment(tx, {
        orderId: order2.id,
        provider: 'DHL_GLOBAL',
        adapterOverride: crossBorderAdapter
      });
    });

    await db.withTenant({ tenantId }, async (tx) => {
      const transfers = await tx.query('transfer_records', t =>
        t.tenant_id === tenantId && t.shipment_id === shipment2.id
      );

      assert.strictEqual(transfers.length, 1, 'Statutory transfer record logged for cross-border provider');
      const tr = transfers[0];
      assert.strictEqual(tr.recipient, 'DHL_GLOBAL');
      assert.strictEqual(tr.legal_basis, 'Article 43 Law 18-07 / 25-11');
      assert.strictEqual(tr.status, 'COMPLETED');

      // Verify transfer_records is append-only
      await assert.rejects(
        async () => {
          await tx.update('transfer_records', tr.id, { status: 'MODIFIED' });
        },
        /Audit Trail Violation: transfer_records records are strictly immutable and append-only/
      );
      await assert.rejects(
        async () => {
          await tx.delete('transfer_records', tr.id);
        },
        /Audit Trail Violation: transfer_records records cannot be deleted/
      );
    });
  });

  await t.test('INV-07-07 & INV-07-16: Carrier credentials encryption at rest and secret masking', async () => {
    const rawCredentials = {
      apiId: 'yal_live_id_9988',
      apiToken: 'secret_token_abcdef1234567890',
      apiKey: 'api_key_zyxw987654321',
      webhookSecret: 'whsec_9999888877776666'
    };

    // 1. Encryption at rest via AES-256-GCM
    const encrypted = encryptCredentials(rawCredentials);
    assert.ok(encrypted.ciphertext, 'Ciphertext generated');
    assert.ok(encrypted.iv, 'IV generated');
    assert.ok(encrypted.tag, 'Auth tag generated');
    assert.ok(!encrypted.ciphertext.includes('secret_token'), 'Ciphertext does not leak plaintext token');

    // 2. Decryption yields original credentials
    const decrypted = decryptCredentials(encrypted);
    assert.deepStrictEqual(decrypted, rawCredentials);

    // 3. Masking for client responses and logs
    const masked = maskCredentials(rawCredentials);
    assert.ok(masked.apiToken.includes('***'), 'Token masked');
    assert.ok(masked.apiKey.includes('***'), 'Key masked');
    assert.ok(!JSON.stringify(masked).includes('secret_token_abcdef1234567890'), 'Plaintext token absent from masked output');
  });
});
