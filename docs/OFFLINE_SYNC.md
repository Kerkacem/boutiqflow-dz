# BoutiqFlow DZ — Offline POS, Printing & Synchronization Architecture

**Operational Reality:** In Algerian shopping malls and commercial streets (Didouche Mourad, Medina Jdida, Bazar El Eulma), 4G/ADSL internet cuts out regularly. Cashiers cannot freeze checkout queues while waiting for network reconnection.

---

## 1. Offline Execution Architecture

```
                       [ Cashier Action: Scan Barcode & Sell ]
                                         │
                                         ▼
                     [ Local Transaction Engine (In-Memory) ]
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
     [ Local Receipt Generation ]                     [ IndexedDB Outbox Queue ]
                 │                                    (Durable local storage:
                 ▼                                     device_id, seq_no, payload)
       [ ReceiptPrinter Abstraction ]
                 │
  ┌──────────────┼──────────────┬──────────────┐
  ▼              ▼              ▼              ▼
[Browser Print] [ESC/POS USB] [ESC/POS Net] [Bluetooth]
```

---

## 2. Offline Receipt Printing Abstraction

### 2.1 Principle: Instant Local Generation
Receipts MUST NOT depend on a server response to print. The receipt payload is formatted locally in the browser immediately upon tender completion.

### 2.2 Printer Abstraction Architecture (`src/pos/printer.js`)
```javascript
class ReceiptPrinter {
  constructor(adapter) {
    this.adapter = adapter; // BrowserAdapter, EscPosUsbAdapter, EscPosNetworkAdapter, BluetoothAdapter
  }

  async printReceipt(saleData, options = {}) {
    const formattedPayload = this.generateEscPosBuffer(saleData, options);
    return await this.adapter.send(formattedPayload);
  }

  generateEscPosBuffer(saleData, { paperWidth = 80, language = 'ar' }) {
    // Generates ESC/POS commands with RTL text shaping, logo bitmap, and barcode
  }
}
```

### 2.3 Supported Thermal Printers in Algeria:
- **Paper Widths:** 58mm (portable Bluetooth/USB) and 80mm (countertop POS thermal printers like Xprinter, Rongta, Bixolon, Epson).
- **Character Encoding:** Bilingual Arabic (CP1256 / UTF-8 with Arabic reshaping) and French/Latin.

---

## 3. Reconnection Synchronization & Conflict Resolution

### 3.1 Idempotent Sync Protocol
1. Each transaction generated offline receives:
   - `client_operation_id`: UUIDv7.
   - `device_id`: e.g. `POS-REG-01`.
   - `sequence_number`: Monotonic counter (`101`, `102`, `103`...).
   - `idempotency_key`: `offline_${device_id}_${sequence_number}`.
2. When internet connectivity returns, the PWA outbox service flushes records sequentially to `POST /api/pos/sync`.
3. The server executes each transaction inside `withTenant({ tenantId }, tx)`:
   - If `idempotency_keys` already contains the key, the server returns the cached success response.
   - If the key is new, the server executes `applyStockMovement()`, records the sale, and logs the idempotency record atomically.

### 3.2 Conflict Resolution Invariant (In-Store Possession Wins)
If an in-store cashier completes an offline sale for the last unit of a variant while simultaneously an unconfirmed online order requested the same variant:
- **Resolution:** The physical in-store sale always takes precedence because the customer physically walked out of the store with the merchandise.
- The online order is flagged as `OUT_OF_STOCK` and routed to customer support for size/color alternative proposal via WhatsApp.
