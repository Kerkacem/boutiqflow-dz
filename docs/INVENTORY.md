# BoutiqFlow DZ — Authoritative Central Inventory Ledger Specification (Phase 03)

**Core Engineering Principle:** The BoutiqFlow DZ Central Inventory Domain Service is the **sole authoritative mutator** of stock balances. Ad-hoc mutations like `products.stock = products.stock - 1` scattered across controllers or routes are strictly forbidden.

---

## 1. Mandatory Mathematical Invariants

Every inventory operation must preserve these mathematical truths:

| Invariant | Formulation / Condition | Enforcement Mechanism |
| :--- | :--- | :--- |
| **INV-03-01** | $OnHand \ge 0$ | Blocked in `executeStockMutation` unless `allowNegative` explicitly set. |
| **INV-03-02** | $Reserved \ge 0$ | Decrement operations clamp at zero and reject negative reservation values. |
| **INV-03-03** | $Reserved \le OnHand$ | Reservations cannot exceed on-hand. Physical POS sales clamp reserved stock if shelf is truth. |
| **INV-03-04** | $Available \equiv OnHand - Reserved \ge 0$ | `Available` is strictly derived. Materialized level is continuously validated. |
| **INV-03-05** | Authoritative Ledger Event | Exactly one immutable movement record created per atomic stock mutation in `stock_movements`. |
| **INV-03-06** | Ledger Immutability | `UPDATE` and `DELETE` on `stock_movements` are blocked at DB layer with `Ledger Violation`. |
| **INV-03-07** | Idempotent Reservation Release | Releasing an already `RELEASED` or `CANCELLED` reservation returns success with no extra decrements. |
| **INV-03-08** | Idempotent Reservation Consume | Consuming an already `CONSUMED` reservation returns cached state with zero duplicated decrements. |
| **INV-03-09** | Idempotent Mutation | Replaying identical `operationId` returns cached result via `idempotency_keys` table. |
| **INV-03-10** | Concurrency Safety | Asynchronous operations serialized via re-entrant in-memory mutex (`withInventoryLocks`). |
| **INV-03-11** | Cross-Tenant Isolation | Variant, Location, and Reservation tenant IDs verified under RLS before any mutation. |
| **INV-03-12** | Historical Stock Integrity | Ledger movements capture point-in-time cost, price, and quantities; catalog updates never alter history. |
| **INV-03-13** | Inventory Architectural Boundary | Direct mutation on `stock_levels`, `stock_movements`, `stock_reservations` outside `InventoryService` throws `Architectural Boundary Violation`. |
| **INV-03-14** | Atomic Transaction Boundary | Multi-step operations rollback completely upon failure via `tx.rollback()`. |

---

## 2. Complete Stock Movement Taxonomy

| Movement Type | Direction | Triggering Event | Effect on On-Hand | Effect on Reserved |
| :--- | :---: | :--- | :---: | :---: |
| `RECEIPT` / `RECEIVING` | $+$ | Inbound supplier shipment received | Increases (Recalculates WAC) | Unchanged |
| `SALE` / `POS_SALE` | $-$ | In-store physical POS checkout or order shipment | Decreases | Clamped if physical |
| `RETURN` / `RETURN_RESTOCK`| $+$ | Customer return inspected & resalable | Increases | Unchanged |
| `TRANSFER_OUT` | $-$ | Inter-location transfer (source location) | Decreases | Unchanged |
| `TRANSFER_IN` | $+$ | Inter-location transfer (destination location) | Increases | Unchanged |
| `ADJUSTMENT_IN` | $+$ | Physical stocktake found surplus items | Increases | Unchanged |
| `ADJUSTMENT_OUT` | $-$ | Physical stocktake found missing items | Decreases | Unchanged |
| `RESERVATION` | $0$ | Online COD order phone confirmation | Unchanged | Increases |
| `RESERVATION_RELEASE` | $0$ | Confirmed online order cancelled | Unchanged | Decreases |

---

## 3. Reservation State Machine

```
              ┌─────────────┐
              │   ACTIVE    │
              └──────┬──────┘
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   ┌──────────────┐      ┌──────────────┐
   │   RELEASED   │      │   CONSUMED   │
   │ (Cancelled)  │      │  (Fulfilled) │
   └──────────────┘      └──────────────┘
```

1. **ACTIVE:** Stock is reserved ($Reserved += Qty$, $Available -= Qty$, $OnHand$ unchanged).
2. **RELEASED / CANCELLED:** Order cancelled ($Reserved -= Qty$, $Available += Qty$). Idempotent: safe to call repeatedly.
3. **CONSUMED:** Order dispatched / sold ($OnHand -= Qty$, $Reserved -= Qty$, $Available$ unchanged). Idempotent.
4. **EXPIRED:** Automated expiration after TTL minutes releases reservation back to available pool.

---

## 4. Multi-Location Transfer Protocol & Lifecycle

Transfer lifecycle states:
- `DRAFT`: Initial draft plan.
- `PENDING`: Approved for dispatch, awaiting arrival.
- `COMPLETED`: Atomic execution of `TRANSFER_OUT` at source and `TRANSFER_IN` at destination.
- `CANCELLED`: Aborted prior to completion.

```
Location A (Warehouse)                Location B (Shop)
        │                                     │
        ├─── [TRANSFER_OUT: -Qty] ───────────►│
        │    (Atomically committed in 1 tx)   │
        │◄─── [TRANSFER_IN:  +Qty] ───────────┤
```

---

## 5. Stock Adjustments with Mandatory Explicit Reasons

Adjustments require an auditable reason from the restricted enumeration:
- `DAMAGED`: Goods physically broken, soiled, or unsellable.
- `LOST`: Shrinkage or unlocated garments during stocktake.
- `COUNT_CORRECTION`: Data entry corrections.
- `FOUND`: Unrecorded units discovered in stockrooms.
- `INITIAL_STOCK`: Opening stock balance upon store onboarding.
- `OTHER`: Exceptional audited business events with explanatory notes.

---

## 6. Weighted Average Cost (WAC / PMP) Calculation

When purchasing goods from clothing manufacturers or wholesalers, cost prices fluctuate across batches. BoutiqFlow DZ updates the unit cost price using the Weighted Average Cost (Prix Moyen Pondéré) formula:

$$\text{New WAC} = \frac{(\text{Current OnHand} \times \text{Current WAC}) + (\text{Received Qty} \times \text{New Unit Cost})}{\text{Current OnHand} + \text{Received Qty}}$$

All calculations are executed in integer centimes to eliminate fiscal rounding drift.
