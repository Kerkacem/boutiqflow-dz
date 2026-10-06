const { processSale } = require('./register');

/**
 * Offline PWA Outbox & Sync Engine
 * Manages queued offline sales and synchronizes them idempotently upon network reconnection.
 */

class OfflineOutbox {
  constructor(deviceId) {
    this.deviceId = deviceId || 'POS-DEVICE-1';
    this.sequence = 0;
    this.queue = [];
  }

  enqueueSale(salePayload) {
    this.sequence += 1;
    const idempotencyKey = `offline_${this.deviceId}_seq_${this.sequence}`;
    const queuedItem = {
      ...salePayload,
      deviceId: this.deviceId,
      sequenceNumber: this.sequence,
      idempotencyKey,
      enqueuedAt: new Date().toISOString()
    };
    this.queue.push(queuedItem);
    return queuedItem;
  }

  getPendingSales() {
    return [...this.queue];
  }

  clear() {
    this.queue = [];
  }
}

/**
 * Synchronizes queued offline sales to the server within tenant transaction
 */
async function syncOfflineOutbox(tx, outbox) {
  const pending = outbox.getPendingSales();
  const syncResults = [];

  for (const item of pending) {
    const res = await processSale(tx, {
      sessionId: item.sessionId,
      locationId: item.locationId,
      cashierId: item.cashierId,
      customerId: item.customerId,
      items: item.items,
      payments: item.payments,
      discountCentimes: item.discountCentimes,
      idempotencyKey: item.idempotencyKey,
      deviceId: item.deviceId,
      sequenceNumber: item.sequenceNumber
    });
    syncResults.push(res);
  }

  outbox.clear();
  return {
    synchronizedCount: syncResults.length,
    results: syncResults
  };
}

module.exports = {
  OfflineOutbox,
  syncOfflineOutbox
};
