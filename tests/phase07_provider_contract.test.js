const test = require('node:test');
const assert = require('node:assert');
const {
  YalidineAdapter,
  ZrExpressAdapter,
  NoestAdapter,
  MaystroAdapter,
  GenericDeliveryProvider,
  FakeDeliveryProvider,
  SHIPMENT_STATUSES,
  DELIVERY_PROVIDERS,
  DELIVERY_TYPES
} = require('../src/delivery');

test('Phase 07 — Delivery Provider Adapter Contract Suite (INV-07-20)', async (t) => {
  const adapters = [
    { name: 'Yalidine', adapter: new YalidineAdapter({ id: 'acc-yal', apiKey: 'test-key', apiToken: 'test-token' }) },
    { name: 'ZR Express', adapter: new ZrExpressAdapter({ id: 'acc-zr', apiKey: 'zr-key' }) },
    { name: 'Noest', adapter: new NoestAdapter({ id: 'acc-noe', apiKey: 'noe-key' }) },
    { name: 'Maystro', adapter: new MaystroAdapter({ id: 'acc-may', apiKey: 'may-key' }) },
    { name: 'Generic', adapter: new GenericDeliveryProvider({ id: 'acc-gen', provider: 'GENERIC' }) },
    { name: 'Sandbox', adapter: new FakeDeliveryProvider({ id: 'acc-sbx' }) }
  ];

  for (const { name, adapter } of adapters) {
    await t.test(`${name} Adapter: Contract Conformance`, async () => {
      // 1. Rate quote test
      const homeRate = await adapter.getRates({ wilaya: 'Alger', isStopdesk: false });
      assert.ok(homeRate.shippingFeeCentimes > 0n, `${name} home quote returns positive centimes`);
      assert.ok(homeRate.estimatedDays >= 1, `${name} estimated days is positive`);

      const stopdeskRate = await adapter.getRates({ wilaya: 'Oran', isStopdesk: true });
      assert.ok(stopdeskRate.shippingFeeCentimes > 0n, `${name} stopdesk quote returns positive centimes`);

      // 2. Create shipment test
      const shipment = await adapter.createShipment({
        orderNumber: `BF-${name.replace(/\s+/g, '')}-001`,
        customerName: 'Amina Mansouri',
        customerPhone: '0550112233',
        address: 'Cite 500 Logements',
        wilaya: 'Constantine',
        commune: 'El Khroub',
        codAmountCentimes: 450000n, // 4,500 DA
        isStopdesk: true,
        clientReference: `ref-${name}-001`
      });

      assert.ok(shipment.success, `${name} create shipment success`);
      assert.ok(shipment.trackingNumber, `${name} tracking number populated`);
      assert.strictEqual(shipment.codAmountCentimes, 450000n, `${name} cod amount matches`);
      assert.ok(shipment.canonicalStatus, `${name} canonical status populated`);
      assert.ok(shipment.shippingFeeCentimes > 0n, `${name} shipping fee populated`);

      // 3. Track shipment test
      const tracking = await adapter.trackShipment(shipment.trackingNumber);
      assert.strictEqual(tracking.trackingNumber, shipment.trackingNumber);
      assert.ok(tracking.canonicalStatus, `${name} tracking canonical status`);

      // 4. Cancel shipment test
      const cancellation = await adapter.cancelShipment(shipment.providerShipmentId || shipment.trackingNumber);
      assert.strictEqual(cancellation.status, SHIPMENT_STATUSES.CANCELLED);

      // 5. Status normalization test
      const deliveredStatus = adapter.normalizeStatus('livré');
      assert.strictEqual(deliveredStatus, SHIPMENT_STATUSES.DELIVERED);

      const returnedStatus = adapter.normalizeStatus('retourné');
      assert.strictEqual(returnedStatus, SHIPMENT_STATUSES.RETURNED);
    });
  }

  await t.test('Sandbox: Simulated Auth Failure (INV-07-16)', async () => {
    const sandbox = new FakeDeliveryProvider({ id: 'acc-sbx-fail' });
    sandbox.authFailNextCreate = true;

    await assert.rejects(
      async () => {
        await sandbox.createShipment({
          orderNumber: 'BF-AUTH-FAIL',
          customerName: 'Test',
          customerPhone: '0555000000',
          wilaya: 'Alger',
          commune: 'Centre',
          codAmountCentimes: 1000n
        });
      },
      /Authentication failed/
    );
  });
});
