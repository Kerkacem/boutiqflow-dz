# BoutiqFlow DZ — Phase 06: COD Confirmation Domain & Online Order Lifecycle

## 1. Objective
Dedicated phone/WhatsApp confirmation state machine, automated stock reservations, order idempotency, and Law 25-11 / 18-07 customer PII protection.

## 2. Invariants & Guardrails
- Reference `PROJECT.md` for permanent engineering invariants (`INV-06-01` to `INV-06-16`).
- Strict adherence to Principle #0: Personal data protection under Algerian Law 18-07 / 25-11.
- No direct stock mutations outside `InventoryDomainService`.
- No stock reservation on initial order creation; reservation only upon server-authorized confirmation.
- Distinct separation of `OnlineOrder` $\ne$ `POS Sale` $\ne$ `Delivery Parcel`.

## 3. Concrete Milestones & Tasks
- [x] Implement COD confirmation state machine (`PENDING`, `CALLING`, `CONFIRMED`, `UNREACHABLE`, `REFUSED`, `CANCELLED`, `EXPIRED`, `STOCK_UNAVAILABLE`)
- [x] Log call attempts with timestamp, agent, channel, and scheduled retry (`ConfirmationAttempt` append-only log INV-06-12)
- [x] Trigger atomic stock reservation exclusively upon server-authorized order confirmation (`InventoryService.reserveStock()` INV-06-02)
- [x] Release reservation at most once if order is cancelled prior to shipment (`INV-06-06`)
- [x] Handle stock unavailability with zero partial reservations (`INV-06-16`)
- [x] Detect 24h duplicate orders and flag risky customer history
- [x] Enforce customer snapshot permanence and role-based PII masking
- [x] Enforce automated personal data processing journal (`carnet automatisé des opérations` INV-06-13)
- [x] Decisive concurrency test: 100 concurrent confirmation requests with same operationId $\rightarrow$ exactly 1 confirmation, 1 reservation set, 0 duplicates

## 4. Verification & Exit Criteria
Tests pass across all Phase 06 suites:
- `tests/phase06_order_lifecycle.test.js`
- `tests/phase06_cod_hostile.test.js`
- `tests/phase06_confirmation_idempotency.test.js`
- `tests/phase06_reservation_integrity.test.js`
- `tests/phase06_pii_access.test.js`
- `tests/phase06_tenant_isolation.test.js`
- `tests/orders_p5.test.js`
- `tests/cod_confirmation.test.js`

**Exit Status:** **GATE 06 = GREEN** (298/298 tests passing across 44 suites in `bash scripts/verify.sh`).
Proceed to Phase 07: Delivery Providers & Shipment Lifecycle.
