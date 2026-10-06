# BoutiqFlow DZ — Phase 09: Dashboard + Reports + Analytics

## 1. Objective
Build an authoritative, auditable, and performant Read/Reporting layer over canonical transactional sources.
Core Principle: **Reports never become a second source of truth.** All reporting queries are strictly read-only and derive directly from canonical event/transaction ledgers.

## 2. Invariants & Guardrails
- Reference `PROJECT.md` Section 1.7 (`INV-09-01` to `INV-09-20`) for permanent reporting engineering invariants.
- Strict Read-Only Boundary: Zero business state mutations inside reporting endpoints (`INV-09-01`).
- Canonical Metric Definitions: Sourced from `src/reporting/constants.js` with semantic versioning (`v1`) (`INV-09-02`).
- Tenant Boundary Protection: Multi-tenant context strictly enforced from session; user-supplied `tenantId` parameter rejected (`INV-09-03`, `INV-09-20`).
- Historical COGS Stability: Evaluated strictly from `cost_snapshot_centimes` at time of sale; subsequent variant price changes never mutate historical margins (`INV-09-04`, `INV-09-05`).
- Strict Decoupling: $Delivered \ne Collected \ne Settled$. Courier COD money never enters cash register drawers automatically (`INV-09-13`).
- Zero-Denominator Safety: Division by zero returns `N/A` or `New` without producing `+∞%` or `NaN` (`INV-09-12`).
- Rebuildability: Read models are completely rebuildable from canonical tables (`INV-09-08`, `INV-09-09`).
- PII Export Protection: Default masking; unmasked exports restricted to Managers/Owners and logged to `processing_journal` under Law 25-11 (`INV-09-16`).

## 3. Concrete Milestones & Tasks
- [x] Database Schema: Added `daily_sales_summaries`, `daily_profit_summaries`, `inventory_summaries`, `report_snapshots`, `reporting_events_log` tables with immutability constraints (`src/db/client.js`)
- [x] Defined Canonical Metric Definitions & Revenue Recognition Policies (`src/reporting/constants.js`)
- [x] Tenant-Aware Timezone Utilities with Local Day Boundary Resolution (`src/reporting/timezone_utils.js`)
- [x] Authoritative Reporting Service (`src/reporting/reporting_service.js`)
  - Sales Summary, Product Sales, Category Sales
  - Inventory Summary, Low Stock Warning, Inventory Aging
  - Cash Drawer Summary, Payment Methods Breakdown
  - Online Order Funnel, COD Logistics Analytics, Courier Summary
  - Supplier Payables Summary, Operating Expenses Summary, Profit & Loss Summary
  - Dashboard Real-Time KPIs with Trend Comparison
- [x] Operational Analytics Intelligence (`src/reporting/analytics_service.js`)
  - Top Products by Units/Revenue/Gross Profit, Slow Products
  - Sales by Hour, Sales by Day of Week, Sales by Algerian Wilaya
  - Return Analytics by Reason, Courier, and Wilaya; Stock Turnover Ratio
- [x] Rebuildable Read Models & Idempotent Event Ingestion (`src/reporting/read_models.js`)
- [x] Automated Reconciliation & Reporting Drift Detection (`src/reporting/reconciliation_service.js`)
- [x] Secure CSV Export & PII Journaling (`src/reporting/export_service.js`)
- [x] Cryptographic Point-in-Time Report Snapshots (`src/reporting/report_snapshot.js`)
- [x] 10 Dedicated Hostile & Verification Test Suites (`tests/phase09_*.test.js`)

## 4. Verification & Exit Criteria
- Automated test command: `bash scripts/verify.sh`
- All 10 Phase 09 test suites pass 100% (35/35 tests passing).
- Complete verification suite passes with zero failures (413/413 tests passing across 71 suites).
- GATE 09 = GREEN.
