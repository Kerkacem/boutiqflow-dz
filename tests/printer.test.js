const test = require('node:test');
const assert = require('node:assert');
const {
  ReceiptPrinter,
  BrowserPrintAdapter,
  EscPosUsbAdapter,
  EscPosNetworkAdapter,
  BluetoothPrinterAdapter
} = require('../src/pos/printer');

test('Phase 4 — Offline Thermal Receipt Printing Abstraction & ESC/POS Adapters', async (t) => {
  const saleData = {
    boutiqueName: 'Boutique Mode Alger',
    receiptNumber: 'R1-000101',
    date: '2026-10-06 14:30:00',
    items: [
      { title: 'T-Shirt Basic DZ (Noir/M)', qty: 2, unitPriceDinar: '2,500', totalDinar: '5,000' },
      { title: 'Jean Slim Stretch (Bleu/32)', qty: 1, unitPriceDinar: '4,800', totalDinar: '4,800' }
    ],
    totalDinar: '9,800',
    paymentMethod: 'Especes (Cash)'
  };

  await t.test('Generates local ESC/POS byte buffer without server roundtrip', () => {
    const printer = new ReceiptPrinter();
    const buffer = printer.generateEscPosBuffer(saleData, { paperWidth: 80 });

    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.length > 50);

    const text = buffer.toString('utf8');
    assert.ok(text.includes('Boutique Mode Alger'));
    assert.ok(text.includes('R1-000101'));
    assert.ok(text.includes('TOTAL: 9,800 DA'));
    assert.ok(text.includes('شكرًا لزيارتكم'));
  });

  await t.test('Browser Print Adapter prints locally', async () => {
    const printer = new ReceiptPrinter(new BrowserPrintAdapter());
    const res = await printer.printSaleReceipt(saleData);

    assert.strictEqual(res.type, 'BROWSER');
    assert.strictEqual(res.rendered, true);
  });

  await t.test('ESC/POS USB Adapter transmits raw binary to POS printer', async () => {
    const printer = new ReceiptPrinter(new EscPosUsbAdapter());
    const res = await printer.printSaleReceipt(saleData);

    assert.strictEqual(res.type, 'ESC_POS_USB');
    assert.strictEqual(res.status, 'SENT');
    assert.ok(res.bytesSent > 0);
  });

  await t.test('ESC/POS Network Adapter targets printer on local LAN IP (e.g. 192.168.1.200:9100)', async () => {
    const printer = new ReceiptPrinter(new EscPosNetworkAdapter({ host: '192.168.1.200', port: 9100 }));
    const res = await printer.printSaleReceipt(saleData);

    assert.strictEqual(res.type, 'ESC_POS_NETWORK');
    assert.strictEqual(res.host, '192.168.1.200');
    assert.strictEqual(res.port, 9100);
    assert.strictEqual(res.status, 'SENT');
  });

  await t.test('Bluetooth Printer Adapter targets mobile wireless printer', async () => {
    const printer = new ReceiptPrinter(new BluetoothPrinterAdapter({ deviceAddress: '00:11:22:33:44:55' }));
    const res = await printer.printSaleReceipt(saleData);

    assert.strictEqual(res.type, 'BLUETOOTH');
    assert.strictEqual(res.deviceAddress, '00:11:22:33:44:55');
    assert.strictEqual(res.status, 'SENT');
  });
});
