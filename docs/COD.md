# BoutiqFlow DZ — Cash-on-Delivery (COD) & Confirmation Domain

**Core Reality:** In Algeria, over 90% of retail ecommerce transactions are Cash on Delivery (COD). Without strict phone confirmation, return rates ("Taux de retour") often exceed 35–45%, causing massive shipping fee losses and inventory lockup.

---

## 1. The COD Confirmation Lifecycle

BoutiqFlow DZ treats order confirmation not as a simple status string, but as an authoritative domain workflow (`src/orders/confirmation_service.js`).

```
                [ New Inbound Order ] (Facebook / Instagram / Shopify / WhatsApp)
                                │
                                ▼
                       [ PENDING_CONFIRMATION ]
                                │
                                ▼
                     [ Confirmation Calling ]
                                │
        ┌───────────────────────┼────────────────────────┐
        ▼                       ▼                        ▼
  [ UNREACHABLE ]         [ REFUSED / CANCEL ]      [ CONFIRMED ]
  (Max 3 attempts,        (Order Cancelled,         (Customer Validated)
   Next attempt scheduled) 0 Stock Held)                 │
                                                         ▼
                                               ⚡ [ RESERVE INVENTORY ]
                                               (Available = OnHand - Reserved)
                                                         │
                                                         ▼
                                               [ PREPARING & PACKING ]
                                                         │
                                                         ▼
                                               [ DISPATCH TO COURIER ]
                                               ⚡ [ DEDUCT ON-HAND STOCK ]
                                                         │
                                        ┌────────────────┴────────────────┐
                                        ▼                                 ▼
                                  [ DELIVERED ]                     [ RETURNED ]
                                (COD Cash Collected)            (Restocked if pristine)
```

---

## 2. Confirmation State Machine & Call Attempts

### 2.1 Confirmation Statuses:
- `PENDING_CONFIRMATION`: New order waiting to be processed by confirmation agent.
- `CALLING`: Currently in contact with customer.
- `CONFIRMED`: Customer confirmed purchase, address, and wilaya.
- `UNREACHABLE`: Customer did not answer (attempt logged with next scheduled callback).
- `CALL_BACK_LATER`: Customer requested a callback at a specific hour.
- `REFUSED`: Customer explicitly stated they no longer want the order.
- `INVALID_NUMBER`: Number does not ring, is out of service, or fake.
- `CANCELLED`: Order cancelled by merchant or customer.

### 2.2 Call Attempt Record Structure:
Each call attempt records:
- `attempt_number`: 1, 2, or 3.
- `agent_id`: Staff member who dialed.
- `attempt_at`: Exact timestamp.
- `channel`: `PHONE_CALL`, `WHATSAPP_MESSAGE`, `SMS`.
- `outcome`: `ANSWERED_CONFIRMED`, `NO_ANSWER`, `BUSY`, `WRONG_NUMBER`, `ASKED_DELAY`.
- `next_attempt_scheduled_at`: Automated recommendation for retry (e.g. +2 hours).
- `notes`: Specific delivery instructions (e.g. "Deliver after 5 PM", "Near the Mosque").

---

## 3. Authoritative Inventory Reservation Protocol

1. **No Premature Stock Deduction:**
   - Raw online orders entering `PENDING_CONFIRMATION` do NOT deduct physical stock from store shelves.
2. **Atomic Reservation upon Confirmation:**
   - At the instant the agent clicks **Confirm Order**, the system invokes `createReservation(tx, { variantId, locationId, qty, orderId })`.
   - Result: $OnHand$ remains unchanged; $Reserved$ increases by quantity; $Available$ decreases by quantity.
   - The store POS immediately recognizes that this piece is no longer available to sell to in-store walk-in customers.
3. **Cancellation & Release:**
   - If a confirmed order is cancelled prior to shipment, `releaseReservation()` returns available stock immediately.
4. **Shipment & Fulfillment:**
   - When the parcel is handed over to the courier and tracking barcode scanned, `fulfillReservation()` atomically decrements $OnHand$ and clears the reservation.

---

## 4. COD Remittance & Financial Reconciliation

When couriers deliver parcels, they collect cash on behalf of the boutique.
- **Courier Debt Ledger:** Track total COD amounts collected by Yalidine/ZR Express/Noest.
- **Remittance Statement (Bordereau de Versement):**
  - Courier remits net funds: $\text{Net Remittance} = \text{Collected COD} - \text{Shipping Fees}$.
  - System reconciles each order individually by tracking number.
  - Automatically reconciles cash deposited into boutique bank account (CCP / BaridiMob / Cash).
- **Return Restocking Condition:**
  - When a parcel returns undelivered, staff must inspect item condition.
  - If intact: restocked to available inventory (`RETURN_RESTOCK`).
  - If damaged or missing parts: recorded to loss write-off ledger (`DAMAGED_WRITE_OFF`), never restocked blindly.
