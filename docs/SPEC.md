# MAHAL — Comprehensive Technical & Functional Specification

## 1. System Overview & Persona Context
MAHAL is a multi-tenant SaaS application purpose-built for independent apparel retailers in Algeria who operate both a physical boutique and an online/social-commerce business shipping Cash on Delivery (COD).

- **Primary Persona:** Karim (boutique owner, non-technical, relies on low-end Android phone / tablet / budget desktop PC, intermittent 4G/DSL internet connection).
- **Core Value Proposition:** Single source of truth for inventory across shop floor and online channels, eliminating overselling, tracking customer debts ("كريدي"), automating courier COD reconciliations, and calculating true net margins while hiding cost prices from sales clerks.

---

## 2. Invariants & Non-Negotiable Data Rules

All data mutations and database operations must satisfy the following formal invariants:

- **INV-1 (Stock Balance):**
  $$\text{stock\_levels.on\_hand} = \sum \text{stock\_movements.qty}$$
  Per (tenant_id, variant_id, location_id).
- **INV-2 (Availability & Reservations):**
  $$\text{available} = \text{on\_hand} - \text{reserved}$$
  $$\text{reserved} = \sum \text{active reservations}$$
- **INV-3 (Idempotency):**
  Every mutation endpoint capable of being retried requires an `idempotency_key`. The tuple `(tenant_id, idempotency_key)` is globally unique and guarantees exactly-once processing.
- **INV-4 (Fiscal & Transaction Math):**
  $$\text{Total} = \sum \text{Line Totals} - \text{Discounts} + \text{Taxes}$$
  Payments must never exceed the total order amount unless explicit change is tendered. A credit sale must generate exactly one debit entry in the customer ledger.
- **INV-5 (Tenant Isolation):**
  No query, mutation, or API response may access or leak records belonging to another `tenant_id`. Enforced dual-layer via `withTenant()` and PostgreSQL `FORCE ROW LEVEL SECURITY`.
- **INV-6 (Historical Cost Snapshot):**
  Every sale line item must record the snapshot of the variant's cost price at the moment of sale. Historical COGS and gross profits remain immutable regardless of subsequent supplier price fluctuations.
- **INV-7 (Atomic Concurrency):**
  Stock level updates and movement insertions occur in the same database transaction with pessimistic row-locking (`FOR UPDATE` or `INSERT ... ON CONFLICT DO UPDATE`).

---

## 3. Detailed Module Specifications

### 3.1 Catalog & Variants Matrix
- [ ] Product entity: name, category_id, brand_id, season, supplier_id, description.
- [ ] Options & Variants generator: arbitrary combinations (Size $\times$ Color $\times$ Fit).
- [ ] Per-variant fields: SKU, internal barcode (EAN-13 prefix 20-29 or Code128), cost price (bigint centimes), retail price (bigint centimes), image association.
- [ ] Barcode printing: standard 58mm/80mm label printers and A4 sticker sheets (30 per page) via print CSS.
- [ ] CSV/XLSX Bulk Operations:
  - Multi-stage import: File upload $\rightarrow$ Parse $\rightarrow$ Validation preview with per-row error reporting $\rightarrow$ Atomic commit with total rollback on critical failure.
  - Built-in templates: Letter sizes (XS to 3XL), numeric sizes (34 to 48), kids ages (1y to 14y).

### 3.2 Inventory & Multi-Location Ledger
- [ ] Standard locations: `shop` (storefront), `warehouse` (backroom/depot), `in_transit` (courier custody), `damaged` (defective/unsellable).
- [ ] Movement ledger: strictly append-only table `stock_movements`.
- [ ] Negative stock policy: allowed by default on `shop` location (configurable per tenant) to prevent blocking physical checkouts when physical inventory precedes system receiving.
- [ ] Stocktake sessions: freeze snapshot $\rightarrow$ counted quantity entry $\rightarrow$ discrepancy variance report $\rightarrow$ manager approval generating reasoned adjustment movements.
- [ ] Valuation: Weighted Average Cost (WAC / PMP) recalculation on receipt of new goods.

### 3.3 Point of Sale (POS) & Cash Register
- [ ] Optimized for 360px touchscreens and physical keyboard barcode scanners (wedge mode).
- [ ] Cart management: fast scan, search by name/SKU, variant picker grid, hold and resume multiple parked carts.
- [ ] Tenders: Cash (with quick-denomination change calculator), Card (manual TPE), BaridiMob/CCP transfer, Customer Credit ("كريدي"). Split tenders supported.
- [ ] Exchanges & Returns: Size/color replacement within the same transaction flow; returns refunded to original tender or issued as store credit.
- [ ] Register Sessions:
  - Open register with starting cash float.
  - Real-time mid-day X-Report.
  - End-of-day Close with Z-Report: counted cash vs expected cash, variance logged, session locked. Cashier PIN required for fast user switching.
- [ ] Offline PWA capability: sales written to local IndexedDB outbox; synchronized with server using per-device sequence numbers (`R1-000123`) and idempotency keys upon network reconnection.

### 3.4 Online Orders & COD Shipping Logistics
- [ ] Order Ingestion: manual message entry, CSV import, secured REST API, Shopify orders webhook with HMAC validation.
- [ ] Confirmation Kanban: `New` $\rightarrow$ `Confirmed` $\rightarrow$ `Postponed` $\rightarrow$ `Cancelled` $\rightarrow$ `Packed` $\rightarrow$ `Shipped` $\rightarrow$ `Delivered` $\rightarrow$ `Return Pending` $\rightarrow$ `Return Received` $\rightarrow$ `Lost`.
- [ ] Stock allocation hooks: Confirm reserves stock; Ship deducts stock and releases reservation; Return-received restocks to shop or damaged location.
- [ ] Risk scoring: automatic flag for duplicate orders (same phone within 24h) and repeat refuse/return history from tenant's past orders.
- [ ] Courier Integrations (Modular Adapter Pattern):
  - Interface: `listTerritories()`, `quote()`, `createShipment()`, `track()`, `cancel()`, `labelUrl()`.
  - Target providers: Yalidine, Ecotrack engine, ZR Express, Maystro, Noest.
  - Strict confidentiality: Zero customer PII shared with unauthorized third-party aggregators.
- [ ] COD Financial Reconciliation:
  - Expected cash per courier shipment vs actual cash remitted.
  - Deductions for return fees and shipping fees.
  - Net outstanding balance ledger.

### 3.5 Customer Ledger ("كريدي") & Suppliers
- [ ] E.164 phone normalization (+213 prefix, handling local 05/06/07).
- [ ] Debt tracking: sales on credit debit customer balance; debt payments credit balance.
- [ ] Debt aging report (0-30 days, 31-60 days, 60+ days) and payment receipt printout.
- [ ] Supplier purchase orders, partial receiving, and supplier payment ledger.

### 3.6 Financials & Reporting
- [ ] Categorized operating expenses (rent, electricity, packaging, wages, marketing).
- [ ] True Profit & Loss statement: $\text{Net Sales} - \text{COGS (from line snapshots)} - \text{Operating Expenses}$.
- [ ] Stock intelligence: Dead stock detector (zero sales in 60 days), size-curve sell-through analysis.

### 3.7 Multi-Tenant SaaS & Subscription Management
- [ ] Subscription Tiers: Basic (1,500 DA/mo), Pro (3,000 DA/mo), Enterprise (5,500 DA/mo).
- [ ] Entitlements: max users, locations, variants, monthly orders.
- [ ] Subscription Lifecycle: `trialing (14 days)` $\rightarrow$ `active` $\rightarrow$ `past_due (7 days grace)` $\rightarrow$ `read_only` $\rightarrow$ `suspended`. Zero data deletion on non-payment.
- [ ] Billing Methods:
  - Manual BaridiMob/CCP: reference code generated, receipt image uploaded, super-admin approval.
  - Chargily Pay V2: automated CIB/Edahabia checkout, signature verification, status polling fallback.
- [ ] Super-Admin Console: tenant oversight, subscription override, impersonation with audit log, mandatory TOTP 2FA.

### 3.8 Role-Based Access Control (RBAC)
- Roles: `owner`, `manager`, `cashier`, `stock_clerk`, `accountant`.
- Principle of Least Privilege: Cashiers and stock clerks cannot access cost prices, profit margins, financial reports, or data export endpoints.

---

## 4. Testable Acceptance Scenarios (18 UAT Gates)

| Scenario # | Focus | Acceptance Condition |
|---|---|---|
| **UAT-1** | Tenant Onboarding | User signs up $\rightarrow$ trial activated $\rightarrow$ imports 200 products $\rightarrow$ prints labels. |
| **UAT-2** | Purchasing & WAC | Purchase order received for 50 units across sizes; stock and WAC cost update accurately. |
| **UAT-3** | POS Split Sale | Cart with 3 items sold via cash + credit; debt ledger debited; stock decremented. |
| **UAT-4** | POS Offline Outbox | 5 sales processed offline in IndexedDB; reconnects; all 5 sync idempotently without stock drift. |
| **UAT-5** | Concurrent Race Condition | Last unit of M/Black sold at POS and online simultaneously; policy prevents duplicate fulfillment. |
| **UAT-6** | Online Order Lifecycle | New $\rightarrow$ Confirm (reserve) $\rightarrow$ Ship (deduct) $\rightarrow$ Delivered $\rightarrow$ COD remittance reconciled. |
| **UAT-7** | Return Restocking | Delivered item returned $\rightarrow$ verified $\rightarrow$ restocked to designated location; ledger updated. |
| **UAT-8** | Store Size Exchange | Customer swaps Size M for Size L in a single zero-differential POS exchange transaction. |
| **UAT-9** | Physical Stocktake | Physical count of 30 variants entered; variances logged as reasoned adjustment movements. |
| **UAT-10** | Register Z-Report | Cash drawer counted; variance vs calculated sales logged; register locked with daily report. |
| **UAT-11** | Financial Reconciliation | 30 days of seeded sales, returns, and expenses match manual P&L calculation down to centime. |
| **UAT-12** | RBAC Enforcement | Cashier attempting to view cost prices or void transactions receives 403 Forbidden. |
| **UAT-13** | Tenant Isolation Attack | Tenant A attempting to read/update/delete Tenant B's data or files receives 404/403 across all routes. |
| **UAT-14** | Billing & Webhooks | Trial expiry transitions to read-only; forged Chargily webhook rejected; replay webhook handled safely. |
| **UAT-15** | Disaster Recovery | Database dump wiped and restored; system passes data integrity and invariant checks. |
| **UAT-16** | Data Portability & GDPR/18-07 | Complete JSON/CSV data export generated; tenant deletion leaves zero orphaned records. |
| **UAT-17** | RTL & Localization | Arabic default with correct RTL layout, phone numbers, and currency formatting; clean French switch. |
| **UAT-18** | Risk & Fraud Prevention | Duplicate order flag raised for identical customer contact within 24h; bad-debt customer flagged. |
