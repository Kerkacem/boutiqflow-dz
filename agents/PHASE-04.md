# BoutiqFlow DZ — Phase 04: POS Register, Cash Control, Split Payments & Offline Printing

## 1. Objective
High-speed physical store checkout with cash drawer control and local receipt printing.

## 2. Invariants & Guardrails
- Reference `PROJECT.md` for permanent engineering invariants (`INV-04-01` to `INV-04-14`).
- Strict adherence to Principle #0: Personal data protection under Algerian Law 18-07 / 25-11.
- No direct stock mutations outside `InventoryDomainService`.
- No floating-point arithmetic for currency (strict integer centimes).
- Multi-process distributed concurrency safety for POS sales.

## 3. Concrete Milestones & Tasks
- [x] Implement POS checkout with barcode scanner wedge lookup (< 100ms) (`src/pos/barcode_input.js`)
- [x] Implement split tenders (Cash, CIB, Edahabia, BaridiMob, Customer Credit) (`src/pos/register.js`)
- [x] Implement atomic in-store size/color exchange in single transaction
- [x] Implement cash register shift opening, mid-shift cash-in/out, and Z-report closing with variance calculation
- [x] Implement ReceiptPrinter abstraction (Browser, ESC/POS USB, ESC/POS Network, Bluetooth) for offline local printing (`src/pos/receipts.js`, `src/pos/printer.js`)
- [x] Implement distributed multi-process concurrency verification (`tests/phase04_distributed_concurrency.test.js`)
- [x] Implement full suite of Phase 04 hostile, idempotency, refund, payment, and cash register tests

## 4. Verification & Exit Criteria
Tests pass across all Phase 04 suites:
- `tests/phase04_pos_hostile.test.js`
- `tests/phase04_cash_register.test.js`
- `tests/phase04_payment_integrity.test.js`
- `tests/phase04_refund.test.js`
- `tests/phase04_idempotency.test.js`
- `tests/phase04_receipt.test.js`
- `tests/phase04_distributed_concurrency.test.js`
- `tests/pos_p4.test.js`
- `tests/printer.test.js`

**Exit Status:** **GATE 04 = GREEN** (220/220 tests passing across 32 suites in `bash scripts/verify.sh`).
Proceed to Phase 05: Purchases, Suppliers, Returns, Expenses & True Profit.
