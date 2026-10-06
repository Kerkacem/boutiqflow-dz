# BoutiqFlow DZ — Phase 03: Authoritative Inventory Ledger, Reservations & Concurrency

## 1. Objective
Build the single authoritative Inventory Domain Service.

## 2. Invariants & Guardrails
- Reference `PROJECT.md` for permanent engineering invariants (INV-1, INV-2, INV-03-01 to INV-03-14).
- Strict adherence to Principle #0: Personal data protection under Algerian Law 18-07 / 25-11.
- No direct stock mutations outside `InventoryDomainService` (INV-03-13).
- No floating-point arithmetic for currency.

## 3. Concrete Milestones & Tasks
- [x] Implement applyStockMovement() with append-only stock_movements ledger
- [x] Enforce INV-03-01 to INV-03-04: onHand >= 0, reserved >= 0, reserved <= onHand, available = onHand - reserved
- [x] Enforce INV-03-05 & INV-03-06: Authoritative append-only immutable ledger events (no UPDATE/DELETE)
- [x] Enforce INV-03-07 & INV-03-08: Idempotent reservation release and consumption
- [x] Enforce INV-03-09: Idempotency keys per tenant (operationId deduplication)
- [x] Enforce INV-03-10: Concurrency control and mutex locking preventing overselling (1 vs 100 sales)
- [x] Enforce INV-03-11: Deep cross-tenant inventory isolation
- [x] Enforce INV-03-12: Auditable stock adjustments with explicit reasons
- [x] Enforce INV-03-13: Architectural boundary preventing external domain mutations
- [x] Enforce INV-03-14: Atomic transaction rollback leaving no partial stock mutations
- [x] Implement atomic location transfers with full lifecycle (DRAFT, PENDING, COMPLETED, CANCELLED)
- [x] Implement Weighted Average Cost (WAC / PMP) recalculation on purchase receipt
- [x] Implement physical stocktake discrepancy reconciliation with audit reasons

## 4. Verification & Exit Criteria
All 25 test suites pass across the entire platform, including 5 dedicated Phase 03 test suites:
- `tests/inventory_p3.test.js`
- `tests/phase03_inventory_hostile.test.js`
- `tests/phase03_inventory_concurrency.test.js`
- `tests/phase03_inventory_idempotency.test.js`
- `tests/phase03_inventory_boundary.test.js`
- Automated test command: `bash scripts/verify.sh`
- Result: **GATE 03 = GREEN** (177/177 passing).
