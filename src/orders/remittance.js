/**
 * COD Remittance Reconciliation & Logistics Performance Analytics
 */

async function reconcileCourierRemittance(tx, {
  courierAccountId,
  reference,
  receivedCentimes,
  shipmentIds // Array of shipment UUIDs included in this remittance statement
}) {
  const shipments = [];
  for (const sId of shipmentIds) {
    const s = await tx.findById('shipments', sId);
    if (s && s.courier_account_id === courierAccountId) {
      shipments.push(s);
    }
  }

  let totalCodExpected = 0n;
  let totalShippingFees = 0n;

  for (const s of shipments) {
    if (s.status === 'DELIVERED') {
      totalCodExpected += BigInt(s.cod_amount_centimes);
    }
    totalShippingFees += BigInt(s.shipping_cost_centimes);
  }

  const netExpected = totalCodExpected - totalShippingFees;
  const received = BigInt(receivedCentimes);
  const difference = received - netExpected;

  const remittance = await tx.insert('cod_remittances', {
    courier_account_id: courierAccountId,
    reference,
    expected_centimes: netExpected,
    received_centimes: received,
    fees_centimes: totalShippingFees,
    difference_centimes: difference,
    status: 'RECONCILED'
  });

  return {
    remittanceId: remittance.id,
    reference,
    totalCodExpected,
    totalShippingFees,
    netExpected,
    received,
    difference
  };
}

/**
 * Calculates delivery success rate per courier and per wilaya
 */
async function computeDeliveryMetrics(tx, courierAccountId) {
  const orders = await tx.query('online_orders', o => o.courier_account_id === courierAccountId);
  if (orders.length === 0) {
    return { totalOrders: 0, overallSuccessRate: 0, wilayaBreakdown: {} };
  }

  const total = orders.length;
  let delivered = 0;
  const wilayaStats = {};

  for (const o of orders) {
    const w = o.wilaya;
    if (!wilayaStats[w]) wilayaStats[w] = { total: 0, delivered: 0 };
    wilayaStats[w].total += 1;

    if (o.status === 'DELIVERED') {
      delivered += 1;
      wilayaStats[w].delivered += 1;
    }
  }

  const overallSuccessRate = (delivered / total) * 100;
  const wilayaBreakdown = {};
  for (const [w, stat] of Object.entries(wilayaStats)) {
    wilayaBreakdown[w] = {
      total: stat.total,
      delivered: stat.delivered,
      rate: ((stat.delivered / stat.total) * 100).toFixed(1) + '%'
    };
  }

  return {
    courierAccountId,
    totalOrders: total,
    deliveredCount: delivered,
    overallSuccessRate: overallSuccessRate.toFixed(1) + '%',
    wilayaBreakdown
  };
}

module.exports = {
  reconcileCourierRemittance,
  computeDeliveryMetrics
};
