/**
 * BoutiqFlow DZ — Offline Receipt Engine (INV-04-13, INV-08-18)
 * Renders offline tickets with LOCAL/PENDING indicator and manages
 * localReceiptId -> serverSaleId mapping without duplicate printouts.
 */

const { generateUUIDv7 } = require('../db/utils');
const { ReceiptRenderer } = require('../pos/receipts');

class OfflineReceiptEngine {
  /**
   * Renders receipt locally before server sync
   */
  static renderOfflineReceipt({
    storeName = 'BoutiqFlow DZ',
    registerId,
    cashierName,
    items = [],
    payments = [],
    totalCentimes,
    operationId
  }) {
    const localReceiptId = `OFFLINE-${registerId}-${Date.now().toString(36).toUpperCase()}`;

    // Render thermal receipt text with offline pending disclaimer
    const ticketText = ReceiptRenderer.renderText({
      shopName: storeName,
      receiptNumber: `${localReceiptId} (EN ATTENTE DE SYNCHRO)`,
      cashierName,
      items,
      payments,
      totalCentimes,
      isPendingSync: true,
      operationId
    }, { paperWidth: 80 });

    return {
      localReceiptId,
      operationId,
      ticketText,
      printedAt: new Date().toISOString(),
      isPendingSync: true
    };
  }

  /**
   * Maps local offline receipt to authoritative server sale after sync
   */
  static mapToServerSale({ localReceiptId, serverReceiptNumber, serverSaleId }) {
    return {
      localReceiptId,
      serverReceiptNumber,
      serverSaleId,
      syncedAt: new Date().toISOString(),
      isPendingSync: false
    };
  }
}

module.exports = {
  OfflineReceiptEngine
};
