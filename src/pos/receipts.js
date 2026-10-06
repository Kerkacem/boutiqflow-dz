const { centimesToDinar } = require('../db/utils');

/**
 * POS Receipt & Thermal Invoice Printer Formatter for BoutiqFlow DZ
 * Supports 58mm & 80mm thermal printers and A4 invoices.
 */

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateReceiptHtml({
  shopName = 'BoutiqFlow DZ',
  address = null,
  phone = null,
  receiptNumber,
  cashierName = 'Caissier',
  customerName = null,
  items = [],
  subtotalCentimes = 0n,
  discountCentimes = 0n,
  totalCentimes = 0n,
  payments = [],
  changeDueCentimes = 0n,
  headerText = null,
  footerText = null,
  width = '80mm'
}) {
  if (!receiptNumber) {
    throw new Error('Print Error: Cannot render ticket without confirmed receiptNumber (INV-04-13)');
  }

  const subtotalDA = centimesToDinar(subtotalCentimes);
  const discountDA = centimesToDinar(discountCentimes);
  const totalDA = centimesToDinar(totalCentimes);
  const changeDueDA = centimesToDinar(changeDueCentimes);

  const itemRows = items.map(item => `
    <tr>
      <td class="item-name">${escapeHtml(item.name || item.title || 'Article')} <span class="item-meta">(${escapeHtml(item.color || '')} / ${escapeHtml(item.size || '')})</span></td>
      <td class="item-qty">${item.qty}</td>
      <td class="item-price">${centimesToDinar(item.unitPriceCentimes !== undefined ? item.unitPriceCentimes : 0n)}</td>
      <td class="item-total">${centimesToDinar(item.lineTotalCentimes !== undefined ? item.lineTotalCentimes : (item.totalCentimes !== undefined ? item.totalCentimes : 0n))}</td>
    </tr>
  `).join('\n');

  const paymentRows = payments.map(p => `
    <div class="row">
      <span>${escapeHtml(p.tenderType)}:</span>
      <span>${centimesToDinar(p.amountCentimes !== undefined ? p.amountCentimes : 0n)} DA</span>
    </div>
  `).join('\n');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>وصل بيع — ${escapeHtml(receiptNumber)}</title>
  <style>
    @page { size: ${width} auto; margin: 2mm; }
    body { font-family: 'Courier New', monospace, Tahoma, sans-serif; font-size: 10pt; margin: 0; padding: 2mm; width: ${width}; color: #000; }
    .header { text-align: center; border-bottom: 1px dashed #000; padding-bottom: 2mm; margin-bottom: 2mm; }
    .shop-title { font-size: 13pt; font-weight: bold; }
    .meta-row { font-size: 8pt; margin: 1mm 0; }
    table { width: 100%; border-collapse: collapse; margin: 2mm 0; }
    th { border-bottom: 1px solid #000; text-align: right; font-size: 8pt; padding: 1mm 0; }
    td { padding: 1mm 0; font-size: 9pt; }
    .item-meta { font-size: 7.5pt; color: #333; }
    .item-qty { text-align: center; }
    .item-price, .item-total { text-align: left; }
    .summary-box { border-top: 1px dashed #000; padding-top: 2mm; margin-top: 2mm; }
    .row { display: flex; justify-content: space-between; margin: 1mm 0; }
    .total-row { font-size: 12pt; font-weight: bold; border-top: 1px solid #000; padding-top: 1mm; }
    .footer { text-align: center; font-size: 8pt; margin-top: 4mm; border-top: 1px dashed #000; padding-top: 2mm; }
  </style>
</head>
<body>
  <div class="header">
    <div class="shop-title">${escapeHtml(shopName)}</div>
    ${address ? `<div class="meta-row">${escapeHtml(address)}</div>` : ''}
    ${phone ? `<div class="meta-row">هاتف: ${escapeHtml(phone)}</div>` : ''}
    <div class="meta-row">وصل رقم: <b>${escapeHtml(receiptNumber)}</b></div>
    <div class="meta-row">الكاشير: ${escapeHtml(cashierName)} | ${new Date().toLocaleDateString('fr-DZ')}</div>
    ${customerName ? `<div class="meta-row">الزبون: ${escapeHtml(customerName)}</div>` : ''}
    ${headerText ? `<div class="meta-row">${escapeHtml(headerText)}</div>` : ''}
  </div>

  <table>
    <thead>
      <tr>
        <th>السلعة</th>
        <th>الكمية</th>
        <th>السعر</th>
        <th>المجموع</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>

  <div class="summary-box">
    <div class="row">
      <span>المجموع الفرعي:</span>
      <span>${subtotalDA} DA</span>
    </div>
    ${discountCentimes > 0n ? `
    <div class="row">
      <span>التخفيض:</span>
      <span>-${discountDA} DA</span>
    </div>` : ''}
    <div class="row total-row">
      <span>المجموع الإجمالي:</span>
      <span>${totalDA} DA</span>
    </div>
    ${paymentRows}
    ${changeDueCentimes > 0n ? `
    <div class="row">
      <span>المبلغ المتبقي (الصرف):</span>
      <span>${changeDueDA} DA</span>
    </div>` : ''}
  </div>

  <div class="footer">
    ${footerText ? `<div>${escapeHtml(footerText)}</div>` : ''}
    <div>شكرًا لزيارتكم ونسعد بخدمتكم دائماً</div>
    <div>Merci pour votre confiance !</div>
  </div>
</body>
</html>`;
}

class ReceiptRenderer {
  static renderHtml(saleData, options = {}) {
    return generateReceiptHtml({ ...saleData, ...options });
  }

  static renderText(saleData, { paperWidth = 80 } = {}) {
    if (!saleData || !saleData.receiptNumber) {
      throw new Error('Print Error: Cannot render ticket without confirmed receiptNumber (INV-04-13)');
    }

    const lines = [];
    const width = paperWidth === 58 ? 32 : 40;
    const separator = '-'.repeat(width);

    lines.push(`*** ${saleData.shopName || saleData.boutiqueName || 'BoutiqFlow DZ'} ***`);
    if (saleData.address) lines.push(saleData.address);
    if (saleData.phone) lines.push(`Tel: ${saleData.phone}`);
    lines.push(`Recu N: ${saleData.receiptNumber}`);
    lines.push(`Date: ${saleData.date || new Date().toISOString().substring(0, 19).replace('T', ' ')}`);
    if (saleData.cashierName) lines.push(`Caissier: ${saleData.cashierName}`);
    if (saleData.customerName) lines.push(`Client: ${saleData.customerName}`);
    lines.push(separator);

    for (const item of (saleData.items || [])) {
      const name = item.name || item.title || 'Article';
      const meta = [item.size, item.color].filter(Boolean).join('/');
      const titleLine = meta ? `${name} (${meta})` : name;
      lines.push(titleLine);

      const price = item.unitPriceDA || (item.unitPriceCentimes !== undefined ? centimesToDinar(item.unitPriceCentimes) : (item.unitPriceDinar || ''));
      const lineTotal = item.lineTotalDA || (item.lineTotalCentimes !== undefined ? centimesToDinar(item.lineTotalCentimes) : (item.totalDinar || ''));
      lines.push(`  ${item.qty} x ${price} DA = ${lineTotal} DA`);
    }

    lines.push(separator);

    const totalStr = saleData.totalDA || (saleData.totalCentimes !== undefined ? centimesToDinar(saleData.totalCentimes) : saleData.totalDinar);
    lines.push(`TOTAL: ${totalStr} DA`);

    if (saleData.payments && Array.isArray(saleData.payments)) {
      for (const p of saleData.payments) {
        const pAmt = p.amountDA || (p.amountCentimes !== undefined ? centimesToDinar(p.amountCentimes) : '');
        lines.push(`Paiement (${p.tenderType}): ${pAmt} DA`);
      }
    } else if (saleData.paymentMethod) {
      lines.push(`Paiement: ${saleData.paymentMethod}`);
    }

    if (saleData.changeDueCentimes && saleData.changeDueCentimes > 0n) {
      lines.push(`Rendu: ${centimesToDinar(saleData.changeDueCentimes)} DA`);
    }

    lines.push(separator);
    lines.push('Merci pour votre visite !');
    lines.push('شكرًا لزيارتكم ونسعد بخدمتكم');

    return lines.join('\n');
  }
}

module.exports = {
  escapeHtml,
  generateReceiptHtml,
  ReceiptRenderer
};
