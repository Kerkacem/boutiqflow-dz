const { centimesToDinar } = require('../db/utils');

/**
 * Barcode Label Sheet Generator
 * Generates print CSS HTML for thermal roll (58mm/80mm) and A4 label sheets (30 per page).
 */

function generateLabelSheetHtml(variants, layout = 'a4_30') {
  const isThermal = layout.startsWith('thermal');

  const labelCards = variants.map(v => {
    const priceDA = centimesToDinar(v.sale_price);
    return `
      <div class="label-card">
        <div class="product-title">${escapeHtml(v.product_name || 'Produit')}</div>
        <div class="variant-meta">${escapeHtml(v.color || '')} / ${escapeHtml(v.size || '')}</div>
        <div class="barcode-box">
          <div class="barcode-bars">*${escapeHtml(v.barcode)}*</div>
          <div class="barcode-digits">${escapeHtml(v.barcode)}</div>
        </div>
        <div class="product-price">${priceDA} DA</div>
      </div>
    `;
  }).join('\n');

  const css = isThermal ? `
    @page { size: ${layout === 'thermal_58' ? '58mm' : '80mm'} auto; margin: 2mm; }
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2mm; }
    .label-card { width: 100%; border: 1px dashed #ccc; padding: 4mm; text-align: center; margin-bottom: 3mm; page-break-inside: avoid; }
    .product-title { font-weight: bold; font-size: 11pt; margin-bottom: 1mm; }
    .variant-meta { font-size: 9pt; color: #444; margin-bottom: 2mm; }
    .barcode-box { margin: 2mm 0; }
    .barcode-digits { font-family: monospace; font-size: 10pt; letter-spacing: 2px; }
    .product-price { font-weight: 800; font-size: 12pt; margin-top: 1mm; }
  ` : `
    @page { size: A4 portrait; margin: 10mm; }
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 0; }
    .grid-container { display: grid; grid-template-columns: repeat(3, 1fr); grid-gap: 2mm; }
    .label-card { border: 1px solid #ddd; border-radius: 4px; padding: 3mm; text-align: center; height: 26mm; box-sizing: border-box; page-break-inside: avoid; }
    .product-title { font-weight: bold; font-size: 9pt; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .variant-meta { font-size: 8pt; color: #555; }
    .barcode-digits { font-family: monospace; font-size: 9pt; letter-spacing: 1px; margin: 1mm 0; }
    .product-price { font-weight: bold; font-size: 10pt; }
  `;

  return `<!DOCTYPE html>
<html lang="fr" dir="ltr">
<head>
  <meta charset="utf-8">
  <title>Étiquettes Codes-Barres — MAHAL</title>
  <style>${css}</style>
</head>
<body>
  <div class="${isThermal ? 'thermal-container' : 'grid-container'}">
    ${labelCards}
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  generateLabelSheetHtml
};
