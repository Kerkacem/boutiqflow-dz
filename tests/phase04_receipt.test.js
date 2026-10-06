const test = require('node:test');
const assert = require('node:assert');
const {
  ReceiptRenderer,
  generateReceiptHtml
} = require('../src/pos/receipts');
const {
  ReceiptPrinter,
  BrowserPrintAdapter,
  EscPosUsbAdapter,
  EscPosNetworkAdapter,
  BluetoothPrinterAdapter
} = require('../src/pos/printer');

test('Phase 04 — POS Receipt Rendering, Thermal ESC/POS & Printer Adapters (INV-04-13)', async (t) => {
  const saleData = {
    shopName: 'Boutique Élégance Alger',
    address: '14 Rue Didouche Mourad, Alger',
    phone: '0550112233',
    receiptNumber: 'POS-01-000456',
    date: '2026-10-06 15:30:00',
    cashierName: 'Amine',
    items: [
      {
        name: 'Costume Cérémonie',
        title: 'Costume Cérémonie',
        color: 'Noir',
        size: '50',
        qty: 1,
        unitPriceCentimes: 3500000n, // 35,000 DA
        lineTotalCentimes: 3500000n,
        unitPriceDinar: '35,000',
        totalDinar: '35,000'
      },
      {
        name: 'Cravate Soie',
        title: 'Cravate Soie',
        color: 'Bordeaux',
        size: 'TU',
        qty: 2,
        unitPriceCentimes: 250000n, // 2,500 DA
        lineTotalCentimes: 500000n, // 5,000 DA
        unitPriceDinar: '2,500',
        totalDinar: '5,000'
      }
    ],
    subtotalCentimes: 4000000n,
    discountCentimes: 200000n, // 2,000 DA discount
    totalCentimes: 3800000n,   // 38,000 DA total
    totalDinar: '38,000',
    payments: [
      { tenderType: 'CASH', amountCentimes: 2000000n },
      { tenderType: 'CARD', amountCentimes: 2000000n }
    ],
    changeDueCentimes: 200000n, // 2,000 DA change due from 40,000 DA paid
    paymentMethod: 'MIXED (Cash + Card)'
  };

  await t.test('INV-04-13: Printing without confirmed transaction identity is strictly rejected', async () => {
    const printer = new ReceiptPrinter();

    // 1. Missing receiptNumber in printer buffer generation
    assert.throws(
      () => printer.generateEscPosBuffer({}),
      /Print Error: Cannot generate ticket without confirmed transaction identity \(INV-04-13\)/
    );

    // 2. Missing receiptNumber in printer print command
    await assert.rejects(
      async () => printer.printSaleReceipt({}),
      /Print Error: Cannot print receipt without confirmed transaction identity \(INV-04-13\)/
    );

    // 3. Missing receiptNumber in renderer
    assert.throws(
      () => ReceiptRenderer.renderText({}),
      /Print Error: Cannot render ticket without confirmed receiptNumber \(INV-04-13\)/
    );

    assert.throws(
      () => ReceiptRenderer.renderHtml({}),
      /Print Error: Cannot render ticket without confirmed receiptNumber \(INV-04-13\)/
    );
  });

  await t.test('Receipt Content Verification: Mandatory receipt fields present & zero unnecessary PII', () => {
    const html = ReceiptRenderer.renderHtml(saleData);

    // Mandatory Store Details
    assert.ok(html.includes('Boutique Élégance Alger'), 'Must contain store title');
    assert.ok(html.includes('14 Rue Didouche Mourad, Alger'), 'Must contain store address');
    assert.ok(html.includes('POS-01-000456'), 'Must contain receipt number');
    assert.ok(html.includes('Amine'), 'Must contain cashier name');

    // Items table with sizes and colors
    assert.ok(html.includes('Costume Cérémonie'), 'Must list items');
    assert.ok(html.includes('Noir / 50'), 'Must list variant size and color');
    assert.ok(html.includes('Cravate Soie'), 'Must list items');

    // Totals and math
    assert.ok(html.includes('40000.00 DA'), 'Must render subtotal');
    assert.ok(html.includes('-2000.00 DA'), 'Must render discount');
    assert.ok(html.includes('38000.00 DA'), 'Must render grand total');
    assert.ok(html.includes('2000.00 DA'), 'Must render change due');

    // Zero unnecessary PII
    assert.strictEqual(html.includes('credit_card_number'), false);
    assert.strictEqual(html.includes('cvv'), false);
  });

  await t.test('Monospace Text Ticket Generation for 58mm and 80mm thermal paper', () => {
    const text80 = ReceiptRenderer.renderText(saleData, { paperWidth: 80 });
    assert.ok(text80.includes('Boutique Élégance Alger'));
    assert.ok(text80.includes('Recu N: POS-01-000456'));
    assert.ok(text80.includes('Costume Cérémonie (50/Noir)'));
    assert.ok(text80.includes('TOTAL: 38000.00 DA'));
    assert.ok(text80.includes('Rendu: 2000.00 DA'));
    assert.ok(text80.includes('لزيارتكم'));

    const text58 = ReceiptRenderer.renderText(saleData, { paperWidth: 58 });
    assert.ok(text58.includes('Recu N: POS-01-000456'));
  });

  await t.test('Thermal ESC/POS binary buffer generation with paper-cut command', () => {
    const printer = new ReceiptPrinter();
    const buffer = printer.generateEscPosBuffer(saleData, { paperWidth: 80 });

    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.length > 50);

    // ESC @ Initializer (1B 40)
    assert.strictEqual(buffer[0], 0x1B);
    assert.strictEqual(buffer[1], 0x40);

    // Paper Cut GS V 66 0 (1D 56 42 00) at end of buffer
    const cutSlice = buffer.slice(buffer.length - 4);
    assert.strictEqual(cutSlice[0], 0x1D);
    assert.strictEqual(cutSlice[1], 0x56);
    assert.strictEqual(cutSlice[2], 0x42);
    assert.strictEqual(cutSlice[3], 0x00);
  });

  await t.test('Printer Adapters verification: Browser, USB, Network, Bluetooth', async () => {
    // 1. Browser Print Adapter
    const browserPrinter = new ReceiptPrinter(new BrowserPrintAdapter());
    const resBrowser = await browserPrinter.printSaleReceipt(saleData);
    assert.strictEqual(resBrowser.type, 'BROWSER');
    assert.strictEqual(resBrowser.rendered, true);

    // 2. USB Print Adapter
    const usbPrinter = new ReceiptPrinter(new EscPosUsbAdapter());
    const resUsb = await usbPrinter.printSaleReceipt(saleData);
    assert.strictEqual(resUsb.type, 'ESC_POS_USB');
    assert.strictEqual(resUsb.status, 'SENT');
    assert.ok(resUsb.bytesSent > 0);

    // 3. Network Print Adapter (TCP 9100)
    const netPrinter = new ReceiptPrinter(new EscPosNetworkAdapter({ host: '192.168.1.150', port: 9100 }));
    const resNet = await netPrinter.printSaleReceipt(saleData);
    assert.strictEqual(resNet.type, 'ESC_POS_NETWORK');
    assert.strictEqual(resNet.host, '192.168.1.150');
    assert.strictEqual(resNet.port, 9100);

    // 4. Bluetooth Print Adapter
    const btPrinter = new ReceiptPrinter(new BluetoothPrinterAdapter({ deviceAddress: '00:11:22:33:44:55' }));
    const resBt = await btPrinter.printSaleReceipt(saleData);
    assert.strictEqual(resBt.type, 'BLUETOOTH');
    assert.strictEqual(resBt.deviceAddress, '00:11:22:33:44:55');
  });
});
