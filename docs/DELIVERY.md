# BoutiqFlow DZ — Delivery Providers & Logistics Architecture

**Architecture Priority:** Logistics comes BEFORE external storefronts. In Algerian retail, shipping reliability and courier integration are the foundation of survival.

---

## 1. The Decoupling Invariant: Inventory is King

A courier webhook or status update must **NEVER** directly modify the inventory tables (`stock_levels` or `stock_movements`).

```
    [ Courier Webhook / API ]  (Yalidine, ZR Express, Noest, Maystro)
                │
                ▼
      [ Delivery Provider Adapter ] (Normalizes courier status)
                │
                ▼
        [ Order Service ] (Updates order state: SHIPPED, DELIVERED, RETURNED)
                │
                ▼
    ⚡ [ Inventory Domain Service ] (Executes authoritative StockMovement)
```

---

## 2. Standard Courier Adapter Contract

All courier integrations inherit from `BaseCourierAdapter` (`src/couriers/adapter.js`):

```javascript
class BaseCourierAdapter {
  constructor({ id, apiKey, apiToken, config = {} }) { ... }

  async listTerritories() { /* Returns supported wilayas and communes */ }
  async quote({ wilaya, commune, isStopdesk, weightKg }) { /* Returns shippingCostCentimes */ }
  async createShipment(shipmentData) { /* Returns trackingCode, labelUrl, status */ }
  async track(trackingCode) { /* Returns normalized status: IN_TRANSIT, DELIVERED, RETURNED */ }
  async cancel(trackingCode) { /* Cancels parcel with courier */ }
  async handleWebhook(rawBody, signatureHeader) { /* Verifies and returns event */ }
}
```

---

## 3. Supported Algerian Courier Providers

### 3.1 Yalidine Express
- **Coverage:** 58 Wilayas (Stopdesk & Home Delivery).
- **Features:** Automated parcel registration, thermal shipping label printing (PDF/ZPL), real-time webhook status updates, COD cash tracking.

### 3.2 ZR Express
- **Coverage:** Fast delivery across central, eastern, and western hubs.
- **Features:** Stopdesk pickup, parcel status lifecycle, weekly remittance bordereau reconciliation.

### 3.3 Noest Express
- **Coverage:** Extensive home delivery network.
- **Features:** REST API integration, automated manifest generation, proof-of-delivery tracking.

### 3.4 Maystro Delivery
- **Coverage:** Specialized urban and regional logistics.
- **Features:** Instant dispatch, courier live assignment, mobile driver integration.

### 3.5 Generic Courier Adapter (Livreur Privé)
- **Use Case:** Local in-house delivery drivers or boutique private messengers.
- **Features:** Manual tracking code entry, driver assignment, cash collection handoff checklist.

---

## 4. Normalized Logistics Status Matrix

| Courier Status | Normalized BoutiqFlow Status | Inventory Action |
| :--- | :--- | :--- |
| `EN_ATTENTE` / `CREATED` | `PREPARING` | None (Stock already reserved) |
| `EXPEDIE` / `IN_TRANSIT` | `SHIPPED` | `fulfillReservation()` $\rightarrow$ On-Hand Stock Decremented |
| `LIVRE` / `DELIVERED` | `DELIVERED` | None (Recorded to COD Remittance Ledger) |
| `RETOUR_EN_COURS` | `RETURN_IN_TRANSIT` | None (Awaiting physical receipt) |
| `RETOURNÉ_AU_VENDEUR` | `RETURNED` | Inspected by staff $\rightarrow$ `RETURN_RESTOCK` or `LOSS_WRITE_OFF` |
| `ANNULE` / `CANCELLED` | `CANCELLED` | `releaseReservation()` $\rightarrow$ Available Stock Restored |
