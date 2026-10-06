# BoutiqFlow DZ — Phase 05: Purchases, Suppliers, Expenses, Cost & True Profit

## 1. Objective
Store procurement, supplier POs, partial goods receiving, purchase returns, categorized operational expenses, and exact P&L accounting primitives.

## 2. Invariants & Guardrails
- Reference `PROJECT.md` for permanent engineering invariants (`INV-05-01` to `INV-05-15`).
- Strict adherence to Principle #0: Personal data protection under Algerian Law 18-07 / 25-11 (PII minimal supplier records).
- No direct stock mutations outside `InventoryDomainService`.
- No floating-point arithmetic for currency (strict integer centimes).
- Separation of Revenue, COGS, Stock Asset, Supplier Liabilities, and Operating Expenses.

## 3. Concrete Milestones & Tasks
- [x] Record supplier purchases and update WAC via `CostingService` (`src/procurement/costing_service.js`)
- [x] Implement purchase orders, partial goods receiving, and returns (`src/procurement/procurement_service.js`)
- [x] Implement supplier balance and payment processing with outstanding balance protection (`src/procurement/payables_service.js`)
- [x] Implement categorized operational expenses and controlled voiding (`src/finance/finance.js`)
- [x] Calculate true P&L: Gross Sales - COGS (via snapshot) = Gross Profit; Gross Profit - Expenses = Operating Profit (`src/finance/finance.js`)
- [x] Financial consistency balance verifying Revenue, COGS, Stock Asset, Payables, and Expenses reconcile to the centime
- [x] Verify financial idempotency with `operationId` across receipts, payments, returns, and expenses

## 4. Verification & Exit Criteria
Tests pass across all Phase 05 suites:
- `tests/phase05_purchase_hostile.test.js`
- `tests/phase05_costing.test.js`
- `tests/phase05_supplier_payables.test.js`
- `tests/phase05_expenses.test.js`
- `tests/phase05_profit_integrity.test.js`
- `tests/phase05_financial_idempotency.test.js`
- `tests/finance_p6.test.js`

**Exit Status:** **GATE 05 = GREEN** (261/261 tests passing across 38 suites in `bash scripts/verify.sh`).
Proceed to Phase 06: COD Confirmation Domain & Online Order Lifecycle.
