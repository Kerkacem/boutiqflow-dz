# BoutiqFlow DZ — System Architecture

**Tagline:** كل محلّك في مكان واحد: caisse + stock + online + bénéfice  
**Core Promise:** بيع في المحل، بيع online، والسيستام وحدو يعرف واش بعت وواش بقالك

---

## 1. Architectural Philosophy & Principles
BoutiqFlow DZ is not another generic ERP. It is a purpose-built Operating System for Algerian clothing retailers who sell through physical boutiques, social commerce (Facebook/Instagram/TikTok/WhatsApp), and online storefronts.

1. **Single Authoritative Inventory Service:**
   - No ad-hoc `products.stock = products.stock - 1`.
   - Every mutation is an event in an immutable, append-only `StockMovement` ledger.
   - Core Invariants:
     - `INV-1`: $OnHand = \sum Quantity_{movements}$
     - `INV-2`: $Available = OnHand - Reserved$ ($Available \le OnHand$ strictly enforced)
2. **Dual-Layer Multi-Tenancy:**
   - Application-level scoping via `withTenant()` context wrappers.
   - Database-level isolation enforced via PostgreSQL `FORCE ROW LEVEL SECURITY`.
   - All tenant queries are strictly scoped; cross-tenant reading or IDOR attacks fail at the database engine level.
3. **Algeria-First Reality Engineering:**
   - Currency stored strictly as integer centimes (`bigint`): $1\text{ DZD} = 100\text{ centimes}$. Zero floating-point rounding errors.
   - Algerian phone numbers normalized to E.164 (`+213XXXXXXXXX`).
   - Offline-first PWA POS: local transaction queuing in IndexedDB, monotonic device sequence numbering, and idempotent server reconciliation.
   - Payment layer abstraction: initial release supports manual CCP/BaridiMob bank slip upload + Chargily Pay V2 webhooks, ready for certified SATIM CIB web-merchant integration.
   - Algerian Data Protection Law 18-07 (amended by Law 25-11, July 24, 2025): zero third-party PII tracking, full tenant data export, and 30-day soft-deletion grace window.

---

## 2. High-Level Component Topology

```
+-----------------------------------------------------------------------------------------+
|                                      CLIENT TIER                                        |
|  Next.js 14+ PWA / Tailwind CSS / shadcn/ui / Arabic RTL (Default) & French LTR         |
|  - High-Speed POS Terminal (Barcode Scanner Wedge / Touch / Quick Matrix Selection)     |
|  - Offline Outbox Queue (IndexedDB / Dexie) with Monotonic Device Sequences              |
|  - Online Orders Kanban & COD Remittance Reconciliation                                  |
|  - Real Clothing Variant Matrix (Sizes x Colors) & Physical Stocktake Manager           |
|  - Executive Dashboard & True P&L Analytics                                            |
+-----------------------------------------------------------------------------------------+
                                             | HTTPS / JSON
                                             v
+-----------------------------------------------------------------------------------------+
|                                    APPLICATION TIER                                     |
|  Next.js Server Actions & API Route Handlers                                            |
|  - Middleware: Tenant Context Resolution, Rate Limiting, CSP Nonce, Security Headers    |
|  - Auth & RBAC: Argon2id / PBKDF2-SHA512 Passwords, Secure HttpOnly Cookies, Sessions  |
|  - Transaction Scope: `withTenant(context, fn)`                                         |
|    * Issues `SET LOCAL app.tenant_id = :tenantId`                                       |
|    * Issues `SET LOCAL app.user_id = :userId`                                           |
|                                                                                         |
|  Authoritative Domain Services:                                                         |
|  1. Central Inventory Service (`src/inventory/ledger.js`) - Sole Mutator of Stock     |
|  2. POS & Cash Register Engine (`src/pos/register.js`, `src/pos/offline_sync.js`)       |
|  3. Online Order & COD Remittance Service (`src/orders/orders.js`)                      |
|  4. Channel Connector Subsystem (`src/connectors/` - Shopify, WooCommerce, REST API)   |
|  5. Courier Subsystem (`src/couriers/` - Yalidine, Ecotrack, ZR Express)               |
|  6. SaaS Subscriptions & Billing (`src/saas/` - Manual BaridiMob, Chargily Pay V2)     |
+-----------------------------------------------------------------------------------------+
                                             |
                                             v
+-----------------------------------------------------------------------------------------+
|                                     DATABASE TIER                                       |
|  PostgreSQL 15+ (Production) / Local Zero-Latency Engine (Development & Test Harness)   |
|  - Row Level Security (RLS) on all tenant tables (`FORCE ROW LEVEL SECURITY`)           |
|  - Composite Foreign Keys: `(tenant_id, id)`                                            |
|  - Immutable Append-Only Tables: `stock_movements`, `sale_payments`, `audit_logs`       |
|  - Strict Constraints: `idempotency_keys(tenant_id, key)` UNIQUE                        |
+-----------------------------------------------------------------------------------------+
```

---

## 3. Authoritative Inventory Ledger Engine
All stock modifications across the entire platform must execute through `applyStockMovement()` or `createReservation()` / `fulfillReservation()` / `releaseReservation()`. Direct database updates to `stock_levels` outside this service are strictly prohibited.

```
       POS Sale (Store) ───┐
     Supplier Receiving ───┤
         Customer Return ───┼───> [ Inventory Domain Service ] ───> [ StockMovement Ledger ]
      Location Transfer ───┤          (Validates Invariants              (Append-Only Event)
Online Order Reservation ───┤           INV-1, INV-2, INV-6)                      │
     Stocktake Adjustment ───┘                                                    v
                                                                       [ Stock Level Cache ]
                                                                      (OnHand, Reserved, Avail)
```

### Supported Movement Types:
- `OPENING_BALANCE`: Initial stock setup.
- `PURCHASE` / `RECEIVING`: Inbound supplier receipts updating Weighted Average Cost (WAC).
- `SALE` / `POS_SALE`: Outbound point-of-sale deduction capturing historical cost snapshot.
- `RETURN` / `RETURN_RESTOCK`: Inbound customer returns (only if inspected as resalable).
- `TRANSFER_OUT` & `TRANSFER_IN`: Inter-location inventory movements (Warehouse $\leftrightarrow$ Boutique).
- `ADJUSTMENT_IN` & `ADJUSTMENT_OUT`: Physical stocktake discrepancy reconciliations.
- `ONLINE_RESERVATION`: Temporary hold of available stock upon order confirmation.
- `ONLINE_RELEASE`: Release of held stock if customer cancels or refuses confirmation.
- `ONLINE_FULFILLMENT` / `ONLINE_SHIPMENT`: Final deduction from on-hand upon courier handover.

---

## 4. Multi-Channel Connector Subsystem
To ensure BoutiqFlow DZ remains independent of any single external platform:
1. **Connector Layer (`src/connectors/adapter.js`):** Defines standard polymorphic lifecycle (`connect`, `disconnect`, `validateCredentials`, `normalizeOrder`, `pushInventory`).
2. **Shopify (`src/connectors/shopify.js`) & WooCommerce (`src/connectors/woocommerce.js`):**
   - Cryptographic HMAC-SHA256 webhook verification with timing-safe comparison.
   - SKU-first product/variant resolution.
   - If an external product has no matching SKU, it is never guessed: it is immediately moved to `UNMAPPED ITEMS` for operator triage.
3. **Channel Sync Engine (`src/connectors/sync_engine.js`):**
   - Inbound orders trigger central order creation and automatic inventory reservations.
   - Outbound inventory movements broadcast updated available stock to all connected storefronts.

---

## 5. Offline POS & Synchronization Engine
1. **Local Outbox Pattern:**
   - Cash register works fully offline via IndexedDB.
   - Generates sequential receipt numbers scoped to the physical register (`R1-000101`, `R1-000102`).
   - Every transaction payload receives a deterministic client `operation_id` (UUIDv7) and idempotency key.
2. **Reconnection Synchronization:**
   - Outbox flushes sequentially to server endpoint `/api/pos/sync`.
   - Server processes in transaction scope: if an `operation_id` has already been recorded in `idempotency_keys`, the server returns the cached result without duplicating sales, stock deductions, or cash additions.

---

## 6. Security, Privacy & Regulatory Compliance
- **Authentication:** Salted PBKDF2/Argon2id password hashes, cryptographically random session tokens, rate-limited exponential backoff on failed logins.
- **RBAC:** 5 distinct roles (`OWNER`, `MANAGER`, `STOCK_MANAGER`, `CASHIER`, `ACCOUNTANT`). Cashiers are strictly blocked from viewing product cost prices, supplier details, or profit margins.
- **Audit Logging:** Security-sensitive operations (price changes, manual stock adjustments, cash variance closures, user role changes, tenant data exports) generate immutable audit records.
- **Algerian Law 18-07 / 25-11 Compliance:** Complete data portability export (JSON/CSV) and a 30-day soft-deletion retention window before permanent purge.
