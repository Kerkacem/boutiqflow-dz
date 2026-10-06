#!/usr/bin/env node
const fs = require('fs');
const { MahalDatabase } = require('../src/db/client');
const { processSale, TENDER_TYPES } = require('../src/pos/register');

// Enable cross-process distributed locking
process.env.BOUTIQFLOW_DISTRIBUTED_LOCK = '1';

async function main() {
  const args = process.argv.slice(2);
  const params = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    params[key] = args[i + 1];
  }

  const {
    dbPath,
    tenantId,
    locationId,
    sessionId,
    cashierId,
    variantId,
    workerId
  } = params;

  if (!dbPath || !tenantId || !variantId || !locationId) {
    console.error(JSON.stringify({ success: false, error: 'Missing required worker parameters' }));
    process.exit(1);
  }

  const db = new MahalDatabase({ persistencePath: dbPath });

  try {
    const result = await db.withTenant({ tenantId }, async (tx) => {
      const variant = await tx.findById('product_variants', variantId);
      if (!variant) throw new Error(`Variant ${variantId} not found`);
      const price = BigInt(variant.sale_price);

      return await processSale(tx, {
        sessionId,
        locationId,
        cashierId,
        items: [{ variantId, qty: 1 }],
        payments: [{ tenderType: TENDER_TYPES.CASH, amountCentimes: price }],
        operationId: `worker-sale-${workerId}-${process.pid}`,
        deviceId: `WORKER-${workerId}`
      });
    });

    console.log(JSON.stringify({
      success: true,
      workerId,
      pid: process.pid,
      saleId: result.saleId,
      receiptNumber: result.receiptNumber
    }));
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      workerId,
      pid: process.pid,
      error: err.message
    }));
    process.exit(0);
  }
}

main().catch(err => {
  console.log(JSON.stringify({ success: false, error: err.message, pid: process.pid }));
  process.exit(0);
});
