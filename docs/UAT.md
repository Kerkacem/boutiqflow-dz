# MAHAL — User Acceptance Testing (UAT) Catalog

This catalog outlines executable test scenarios reproducing real-world conditions in Algerian apparel retail shops.

### UAT-1: Tenant Onboarding & Catalog Bootstrap
- **Actor:** New boutique owner (Karim).
- **Steps:** Signs up $\rightarrow$ 14-day trial starts $\rightarrow$ configures shop "Boutique El Bahdja" $\rightarrow$ imports 200 clothing items from CSV $\rightarrow$ preview confirms variant matrix $\rightarrow$ barcode labels generated.
- **Pass Criteria:** 200 products created; barcode sheet PDF formatted for 30-per-page A4 sticker labels.

### UAT-2: Supplier Receiving & Weighted Average Costing
- **Actor:** Manager.
- **Steps:** Creates Purchase Order for 50 pieces of Denim Jacket across sizes (S:10, M:20, L:20) at unit cost 2,500 DA. Receives goods into `shop` location.
- **Pass Criteria:** `stock_levels.on_hand` increased by 50; weighted average cost updated; supplier ledger debited.

### UAT-3: POS Checkout with Split Tender & Customer Credit ("كريدي")
- **Actor:** Cashier.
- **Steps:** Scans 3 items totaling 8,400 DA. Tenders 5,000 DA cash + 3,400 DA customer credit to client "Omar".
- **Pass Criteria:** Cash drawer balance increased by 5,000 DA; customer debt increased by 3,400 DA; inventory reduced by 3; receipt printed in Arabic/French.

### UAT-4: POS Offline Operation & Reconnection Sync
- **Actor:** Cashier during network failure.
- **Steps:** Disconnect network. Complete 5 consecutive sales in POS. Outbox stores sales locally. Restore network. Outbox syncs.
- **Pass Criteria:** Zero duplicates; 5 receipts assigned sequential local receipt numbers; inventory levels synchronized cleanly.

### UAT-5: Concurrency Race Condition (Shop vs Online)
- **Actor:** Cashier and Online Buyer simultaneously.
- **Steps:** Exactly 1 unit of "Black T-Shirt Size M" remaining. Cashier scans item in store while online shopper checks out.
- **Pass Criteria:** The first committed transaction claims the item; the second is gracefully alerted (or allowed if negative stock policy is enabled for shop, or online order flagged out-of-stock). Zero double allocation.

### UAT-6: Online COD Order & Courier Remittance Lifecycle
- **Actor:** E-Commerce Manager & Courier.
- **Steps:** Order received $\rightarrow$ Confirmed (reserves stock) $\rightarrow$ Picked & Packed $\rightarrow$ Handed to Courier (deducts stock, generates tracking label) $\rightarrow$ Delivered $\rightarrow$ Courier remits cash minus shipping fees.
- **Pass Criteria:** Stock reservations accurate; cash remittance reconciled against expected balance.

### UAT-7: Customer Return & Restocking
- **Actor:** Shop Clerk.
- **Steps:** Customer returns delivered COD item. Item inspected $\rightarrow$ restocked to `shop` location.
- **Pass Criteria:** Stock incremented; customer refunded; reverse ledger movement logged.

### UAT-8: Direct Size Exchange
- **Actor:** Cashier.
- **Steps:** Customer exchanges Size M for Size L of identical product.
- **Pass Criteria:** Single transaction; Size M returned, Size L deducted; financial total 0 DA; receipts records exchange.

### UAT-9: Stocktake & Discrepancy Reconciliation
- **Actor:** Store Owner.
- **Steps:** Stocktake session for 30 variants. Physical count reveals 1 missing jacket.
- **Pass Criteria:** System logs adjustment with mandatory reason code ("Inventory Shrinkage"); stock level updated to match physical count.

### UAT-10: End-of-Day Cash Register Close & Z-Report
- **Actor:** Cashier & Owner.
- **Steps:** Register session closed. Cash counted: 45,000 DA (expected 45,200 DA).
- **Pass Criteria:** Discrepancy (-200 DA) logged; Z-Report generated; register locked.

### UAT-11: Monthly P&L Reconciliation
- **Actor:** Owner / Accountant.
- **Steps:** 30 days of synthetic sales, supplier costs, and expenses executed.
- **Pass Criteria:** P&L report precisely matches calculated formula: $\text{Gross Revenue} - \text{COGS} - \text{Expenses}$.

### UAT-12: Role-Based Access Control (RBAC) Enforcement
- **Actor:** Cashier.
- **Steps:** Cashier attempts to inspect supplier cost prices, delete past sales, or export database.
- **Pass Criteria:** Requests rejected with 403 Forbidden; audit log records unauthorized attempt.

### UAT-13: Cross-Tenant Isolation Attack
- **Actor:** Malicious Tenant.
- **Steps:** Tenant A crafts API requests querying or mutating IDs belonging to Tenant B.
- **Pass Criteria:** All requests return 404 Not Found or 403 Forbidden; zero data leakage.

### UAT-14: Subscription Lifecycle & Webhook Hardening
- **Actor:** Super-Admin & Billing Webhook.
- **Steps:** Trial expires $\rightarrow$ account switches to `read_only`. Simulated Chargily webhook with forged HMAC rejected; authentic webhook activates subscription.
- **Pass Criteria:** Replay webhooks processed idempotently; subscriptions accurately activated.

### UAT-15: Backup & Disaster Recovery
- **Actor:** System Admin.
- **Steps:** Backup dump generated, database wiped, restore executed.
- **Pass Criteria:** Application re-attaches and passes data integrity and invariant checks.

### UAT-16: Self-Service Data Export & Account Deletion
- **Actor:** Tenant Owner.
- **Steps:** Owner requests complete data export $\rightarrow$ downloads archive $\rightarrow$ requests account deletion.
- **Pass Criteria:** Full CSV/JSON data provided; deletion soft-locks tenant with 30-day retention purge window.

### UAT-17: Localization & Multi-Language Support
- **Actor:** Bilingual user.
- **Steps:** Toggle language between Arabic (RTL) and French (LTR).
- **Pass Criteria:** Layout flips cleanly; Arabic typography shapes correctly; numbers, dates, and dinars formatted properly.

### UAT-18: Fraud & Duplicate Order Detection
- **Actor:** Online Order Processing.
- **Steps:** Two orders submitted with same phone number and items within 15 minutes.
- **Pass Criteria:** Second order flagged with warning: "Duplicate Order Detected"; customer risk badge displayed.
