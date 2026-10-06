# BoutiqFlow DZ — Product Requirements Document (PRD)

**Codename:** BoutiqFlow DZ  
**Tagline:** كل محلّك في مكان واحد: caisse + stock + online + bénéfice  
**Core Promise:** بيع في المحل، بيع online، والسيستام وحدو يعرف واش بعت وواش بقالك

---

## 1. Executive Summary & Market Opportunity
The Algerian retail software market is saturated with legacy, generic desktop software or complex foreign ERPs (such as Odoo) that require extensive technical training, expensive server setups, and lack native integration with Algerian retail realities.

BoutiqFlow DZ delivers a specialized, multi-tenant SaaS tailored specifically for Algerian clothing boutiques operating both a physical storefront and online Cash on Delivery (COD) sales channels (Facebook, Instagram, TikTok, WhatsApp, Shopify, WooCommerce).

### Primary Problem Solved:
1. **Stock Synchronization Blindspot:** A customer buys the last "T-Shirt Black L" in the physical shop while simultaneously an Instagram follower orders the same piece online. BoutiqFlow DZ unifies stock in real time with automated reservations.
2. **True Clothing Variants:** Sizes and colors are not decorative free-text options; they are first-class variant entities with independent SKUs, EAN-13 barcodes, cost prices, selling prices, and multi-location balances.
3. **True Profit Calculation:** Shop owners often confuse cash turnover with net profit. BoutiqFlow DZ snapshot-tracks Cost of Goods Sold (COGS) and operational expenses (rent, electricity, salaries, courier fees) to compute exact net profit down to the centime.
4. **Algerian Connectivity Realism:** Intermittent internet in Algerian commercial districts must never halt physical checkout. BoutiqFlow DZ provides a local offline PWA with resilient background synchronization.

---

## 2. Target Persona: Karim (The Boutique Owner)
- **Age:** 34 years old. Owns a men's/women's clothing store in a commercial city center (e.g. Kouba, Oran, Sétif).
- **Team:** 1 to 3 shop employees (cashiers/sales assistants).
- **Sales Channels:** Physical store + social media direct messages + website.
- **Logistics:** Ships 15–50 parcels daily via Yalidine, ZR Express, or Ecotrack-based courier companies with Cash on Delivery.
- **Pain Points:** 
  - Employees must never see wholesale supplier cost prices or profit margins.
  - Manual paper notebook for customer debts ("الكريدي").
  - Courier remittance reconciliation is done manually on spreadsheets, leading to unpaid COD amounts or lost return packages.
  - Software must be intuitive enough that a newly hired cashier learns it in under 10 minutes without reading a manual.

---

## 3. Core MVP Scope (10 Functional Modules)

### Module 1: Executive Dashboard
- **Real-time Daily Metrics:**
  - Chiffre d'Affaires (Gross Revenue in DZD)
  - Number of Completed Sales (Store vs. Online)
  - Bénéfice Brut (Gross Profit) & Net Operating Profit
  - Recorded Expenses
  - Total Stock Valuation (at Cost and at Retail)
  - Low-stock & Out-of-stock Variant Alerts
  - Top 5 Selling Products & Top 5 Variants (by Size & Color)
  - Pending Online Orders awaiting confirmation
  - Current Cash Register Drawer Balance

### Module 2: Clothing Catalog & Real Variant Matrix
- **Product Hierarchy:**
  - Product Template (e.g., "T-Shirt Basic DZ")
  - Multi-attribute Matrix: Color (Noir, Blanc, Bleu) $\times$ Size (S, M, L, XL, XXL)
  - Each Variant entity contains:
    - Unique ID (UUIDv7)
    - Variant SKU (e.g., `TS-BAS-BLK-M`)
    - Barcode (EAN-13 with prefix 20–29 & Modulo-10 checksum)
    - Cost Price (WAC / PMP in DZD centimes)
    - Selling Price & Promotional Discount Price
    - On-Hand Stock, Reserved Stock, Available Stock
    - Minimum Low-Stock Alert Threshold
    - Active Status & Image Asset
- **Printable Labels:** 58mm / 80mm thermal barcode sticker generation and A4 30-per-sheet format.

### Module 3: High-Speed POS & Cash Register
- **Checkout Capabilities:**
  - Instant barcode scanner wedge input (< 100ms response time).
  - Quick-search by product name, SKU, or color/size filter.
  - Cart line editing (quantity, manual line discount with manager override, notes).
  - Split Payment Tenders: Cash, CIB, Edahabia, BaridiMob, and Customer Credit ("كريدي").
  - Receipt Printing: 58mm and 80mm thermal receipt formats with bilingual Arabic (RTL) / French text.
  - In-Store Size/Color Exchange in one single atomic transaction (e.g., swap Size M for Size L with 0 DZD net difference).
- **Cash Register Drawer Control:**
  - Session Opening (initial float).
  - Mid-shift Cash-In and Cash-Out with mandatory reason logging.
  - Session Closing (Z-Report): Automatic computation of expected cash vs. physical count with variance detection.

### Module 4: Authoritative Inventory & Multi-Location Ledger
- **Single Source of Truth:**
  - Every inventory change writes to an append-only `StockMovement` table.
  - Direct updates (`stock = stock - 1`) are forbidden.
  - Invariants: $Available = OnHand - Reserved$, $OnHand = \sum Quantity_{movements}$.
- **Movement Types:** Supplier Receiving (updates WAC), Store Sale, Customer Return Restock, Warehouse $\leftrightarrow$ Store Transfer, Stocktake Reconciliation, and Online Reservation/Shipment.
- **Negative Stock Protection:** Configurable per tenant (default: strictly blocked).

### Module 5: Online Orders & Algerian COD Logistics
- **Order Lifecycle (Kanban):**
  `NEW` $\rightarrow$ `PENDING_CONFIRMATION` $\rightarrow$ `CONFIRMED` $\rightarrow$ `PREPARING` $\rightarrow$ `SHIPPED` $\rightarrow$ `DELIVERED` / `RETURNED` / `CANCELLED`.
- **Algerian Geolocation:** Native support for all 58 Wilayas and communes.
- **Stock Reservation Workflow:**
  - Confirmation holds stock: $OnHand = 10$, $Reserved = 1$, $Available = 9$.
  - Cancellation releases hold: $OnHand = 10$, $Reserved = 0$, $Available = 10$.
  - Shipment deducts from on-hand: $OnHand = 9$, $Reserved = 0$, $Available = 9$.
- **Courier Integration:** Unified adapter interface supporting Yalidine, Ecotrack, and ZR Express (tracking, shipping labels, COD remittance reconciliation).
- **Customer Protection:** 24-hour duplicate order prevention and risky customer detection based on historical return rates.

### Module 6: Operating Expenses & True Profit (P&L)
- **Categorized Expense Ledger:**
  - Rent ("كراء")
  - Electricity & Utilities ("كهرباء / غاز / ماء")
  - Employee Salaries ("أجور العمال")
  - Advertising & Social Media Ads ("إعلانات ممولة")
  - Transport & Freight ("نقل وبضاعة")
  - Delivery Fees ("شحن وتوصيل")
  - Packaging & Supplies ("أكياس وتغليف")
  - Miscellaneous ("أخرى")
- **P&L Reporting:** Formula: Gross Sales - Discounts - Customer Returns - COGS (via snapshot) - Operating Expenses = Net Operating Result.

### Module 7: Customer Relationship & Debt Ledger ("الكريدي")
- **Customer Profile:** Full name, normalized Algerian phone number (`+213XXXXXXXXX`), Wilaya, Commune, Address, Notes.
- **Debt Ledger:** Immutable record of credit purchases, partial debt repayments, and aging buckets (0–30 days, 31–60 days, 60+ days).
- **Privacy Compliance:** No unnecessary personal data stored; full customer data export provided under Law 18-07 / 25-11.

### Module 8: Business Reports & Analytics
- **Standard Reports:**
  - Sales by Date (Daily, Weekly, Monthly, Custom Range)
  - Gross Profit & Net Profit Margins
  - Cost of Goods Sold (COGS) Breakdown
  - Operating Expense Distribution
  - Top Selling Products and Top Sizes / Colors
  - Dead Stock Detector (items unsold for 60+ days)
  - Cashier Performance & Drawer Variances
  - Sales Breakdown by Channel (Store POS vs. Online COD)
  - Payment Method Distribution (Cash vs. Card vs. BaridiMob vs. Credit)

### Module 9: Bulk CSV/Excel Product Importer
- **Import Capabilities:**
  - Ingestion of large catalogs (e.g. 2,000+ clothing products).
  - Automatic expansion into size/color variants.
  - Pre-import validation preview with row-level error reporting (e.g., duplicate SKU, missing price, invalid size).
  - All-or-nothing transactional atomic commit: zero rows committed if validation fails.

### Module 10: Resilient Offline POS
- **Offline Architecture:**
  - POS functions completely when internet connectivity drops.
  - Local transactions stored safely in browser IndexedDB.
  - Per-device sequential receipt numbering (`R1-000101`).
  - Automatic background synchronization upon reconnection with server-side idempotency verification.
  - Zero double sales or duplicate stock movements on network retry.

---

## 4. SaaS Administration & Super-Admin Console (`/admin`)
- **Tenant Management:** Provision new stores, view active tenants, review usage telemetry (variants, sales count, storage).
- **Subscription Lifecycle:** Grant 14-day trials, extend trial periods, upgrade/downgrade plans, soft-delete or freeze non-paying accounts.
- **Manual Payment Approvals:** Review BaridiMob/CCP transaction receipts and approve subscription activations.
- **Observability:** Monitor failed synchronization jobs, webhook rejections, and security audit logs.
- **Super-Admin Impersonation:** Logged read-only store inspection for customer support.

---

## 5. Subscription Pricing Strategy

| Plan | Monthly Price | Stores | Users | Key Features |
| :--- | :--- | :--- | :--- | :--- |
| **Starter** | 1,490 DZD / mo | 1 Store | 2 Users | Store POS, Catalog & Matrix, Stock Ledger, Basic Reports, Offline Mode |
| **Pro** | 2,990 DZD / mo | 2 Stores | 5 Users | Everything in Starter + Online Orders Kanban, Courier Adapters, Expense Tracker, Inter-Store Transfers |
| **Business** | 5,990 DZD / mo | 5 Stores | 15 Users | Everything in Pro + Shopify/WooCommerce Connectors, REST API, Advanced RBAC, Priority Support |
| **Founder** | 990 DZD / mo | 1 Store | 3 Users | Special 1-year introductory rate for the first 20 pioneer clothing boutiques |

---

## 6. Fast 10-Minute Onboarding Workflow
The entire onboarding wizard is engineered for instant store readiness:
1. **Store Name & Branding:** Enter boutique trade name and logo.
2. **Location & Wilaya:** Select primary Wilaya and physical boutique address.
3. **Currency & Locale:** Preset to Algerian Dinar (DZD) and Arabic RTL.
4. **Categories & Attributes:** Quick-select clothing categories (T-Shirts, Jeans, Robes) and default sizes (S–XXL).
5. **Product Ingestion:** Option to import CSV catalog or use pre-populated demo clothing dataset.
6. **Opening Stock:** Enter initial variant quantities.
7. **Cash Register Setup:** Open initial cash drawer.
8. **Cashier Invites:** Add store assistants with restricted cashier roles.
9. **Final Banner:** "✅ محلّك جاهز للبيع — ابدأ أول عملية بيع الآن!" (Ready to sell in under 10 minutes).
