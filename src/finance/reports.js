/**
 * Advanced Retail Reporting & Inventory Intelligence Engine
 */

/**
 * Dead Stock Detector (zero sales in last 60 days with positive on-hand inventory)
 */
async function detectDeadStock(tx, daysThreshold = 60) {
  const thresholdDate = new Date(Date.now() - daysThreshold * 24 * 3600 * 1000).toISOString();

  const recentSales = await tx.query('sales', s => s.created_at >= thresholdDate && s.status === 'COMPLETED');
  const recentSaleIds = new Set(recentSales.map(s => s.id));
  const recentItems = await tx.query('sale_items', i => recentSaleIds.has(i.sale_id));
  const activeVariantIds = new Set(recentItems.map(i => i.variant_id));

  const allLevels = await tx.query('stock_levels', l => l.on_hand > 0);
  const deadVariants = [];

  for (const level of allLevels) {
    if (!activeVariantIds.has(level.variant_id)) {
      const variant = await tx.findById('product_variants', level.variant_id);
      if (variant) {
        const product = await tx.findById('products', variant.product_id);
        const tiedUpCapital = BigInt(level.on_hand) * BigInt(variant.cost_price || 0n);
        deadVariants.push({
          variantId: variant.id,
          sku: variant.sku,
          productName: product ? product.name : 'Unknown',
          size: variant.size,
          color: variant.color,
          onHand: level.on_hand,
          costPriceCentimes: variant.cost_price,
          tiedUpCapitalCentimes: tiedUpCapital
        });
      }
    }
  }

  return deadVariants;
}

/**
 * Size-Curve Sell-Through Analysis
 */
async function analyzeSizeCurve(tx, productId = null) {
  const allVariants = await tx.query('product_variants', v => productId ? v.product_id === productId : true);
  const variantMap = new Map(allVariants.map(v => [v.id, v]));

  const saleItems = await tx.query('sale_items', i => variantMap.has(i.variant_id));
  const stockLevels = await tx.query('stock_levels', l => variantMap.has(l.variant_id));

  const sizeMetrics = {};

  for (const v of allVariants) {
    const size = v.size || 'UNIQUE';
    if (!sizeMetrics[size]) {
      sizeMetrics[size] = { unitsSold: 0, currentStock: 0, totalRevenueCentimes: 0n };
    }
  }

  for (const item of saleItems) {
    const v = variantMap.get(item.variant_id);
    if (v) {
      const size = v.size || 'UNIQUE';
      sizeMetrics[size].unitsSold += item.qty;
      sizeMetrics[size].totalRevenueCentimes += BigInt(item.total_centimes);
    }
  }

  for (const level of stockLevels) {
    const v = variantMap.get(level.variant_id);
    if (v) {
      const size = v.size || 'UNIQUE';
      sizeMetrics[size].currentStock += level.on_hand;
    }
  }

  const curveAnalysis = [];
  for (const [size, data] of Object.entries(sizeMetrics)) {
    const totalHandled = data.unitsSold + data.currentStock;
    const sellThroughRate = totalHandled > 0
      ? ((data.unitsSold / totalHandled) * 100).toFixed(1) + '%'
      : '0.0%';

    curveAnalysis.push({
      size,
      unitsSold: data.unitsSold,
      currentStock: data.currentStock,
      sellThroughRate,
      totalRevenueCentimes: data.totalRevenueCentimes
    });
  }

  curveAnalysis.sort((a, b) => b.unitsSold - a.unitsSold);
  return curveAnalysis;
}

/**
 * Customer Credit Aging Report
 */
async function generateCreditAgingReport(tx) {
  const customers = await tx.query('customers', c => BigInt(c.debt_balance_centimes) > 0n);
  const now = Date.now();

  const report = [];

  for (const c of customers) {
    const ledger = await tx.query('customer_ledger', l => l.customer_id === c.id && l.type === 'SALE_CREDIT');

    let bucket0_30 = 0n;
    let bucket31_60 = 0n;
    let bucket60Plus = 0n;

    for (const entry of ledger) {
      const entryTime = new Date(entry.created_at).getTime();
      const ageDays = Math.floor((now - entryTime) / (24 * 3600 * 1000));
      const amt = BigInt(entry.amount_centimes);

      if (ageDays <= 30) {
        bucket0_30 += amt;
      } else if (ageDays <= 60) {
        bucket31_60 += amt;
      } else {
        bucket60Plus += amt;
      }
    }

    report.push({
      customerId: c.id,
      name: c.name,
      phone: c.phone,
      totalDebtCentimes: BigInt(c.debt_balance_centimes),
      current_0_30d: bucket0_30,
      overdue_31_60d: bucket31_60,
      delinquent_60d_plus: bucket60Plus
    });
  }

  return report;
}

/**
 * CSV Export Formatter
 */
function exportToCSV(dataRows, headers) {
  const headerKeys = Object.keys(headers || {});
  if (headerKeys.length === 0) return '';
  const headerLine = headerKeys.map(k => `"${headers[k]}"`).join(',');

  if (!dataRows || dataRows.length === 0) {
    return headerLine;
  }

  const lines = [headerLine];
  for (const row of dataRows) {
    const line = headerKeys.map(k => {
      const val = row[k] !== undefined ? row[k] : '';
      return `"${String(val).replace(/"/g, '""')}"`;
    }).join(',');
    lines.push(line);
  }

  return lines.join('\n');
}

module.exports = {
  detectDeadStock,
  analyzeSizeCurve,
  generateCreditAgingReport,
  exportToCSV
};
