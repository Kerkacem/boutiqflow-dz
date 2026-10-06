# BoutiqFlow DZ — Project Foundations & Invariants

**Codename:** BoutiqFlow DZ  
**Target:** Multi-tenant SaaS for clothing retailers in Algeria (Physical Boutique + Social Commerce / COD + Omnichannel)  
**Tagline:** كل محلّك في مكان واحد: caisse + stock + online + bénéfice  
**Core Promise:** بيع في المحل، بيع online، والسيستام وحدو يعرف واش بعت وواش بقالك

---

## 0. Principle #0: Privacy & Regulatory Reality (Law 18-07 / Law 25-11)
1. **Personal Data is Not Ordinary Application Data:**
   - Personal data (customer names, phone numbers, delivery addresses) must be minimized, access-controlled by role, and tracked in an automated processing journal (`carnet automatisé des opérations` per Art. 41 bis 3 of Law 25-11).
   - Cashiers only view customer contact details necessary for transaction processing or masked previews. Super-admins cannot inspect tenant customer PII without audited justification.
2. **Controller vs. Processor Roles:**
   - The Boutique Merchant is the **Data Controller** (`Responsable du traitement`).
   - BoutiqFlow DZ is the **Data Processor** (`Sous-traitant`).
   - The platform provides a built-in **Register of Processing Activities** (`Registre des activités de traitement`) and an **Incident & Breach Management Module** (Art. 45 bis 8: 5-day notification window for controller to ANPDP; immediate notification from processor to controller).
3. **Data Residency & Transfer Controls:**
   - Architecture must support configurable data residency (`ALGERIA`, `EU`, `OTHER`) and enforce international transfer controls. No personal data may be transferred to external services without explicit compliance configuration.

---

## 1. Core Engineering Invariants

| Code | Invariant Name | Strict Definition |
| :--- | :--- | :--- |
| **INV-1** | Single Authoritative Ledger | All stock changes MUST occur through the `InventoryDomainService`. Direct modification like `stock = stock - 1` is strictly forbidden. $OnHand = \sum Quantity_{movements}$. |
| **INV-2** | Reservation Formula | $Available = OnHand - Reserved$, where $Reserved \ge 0$ and $Available \le OnHand$. |
| **INV-3** | Transaction Idempotency | No sale, payment, or webhook may be processed twice. Client `operation_id` and server `idempotency_keys(tenant_id, key)` protect all financial and stock mutations. |
| **INV-4** | Strict BigInt Currency | All monetary values (prices, costs, discounts, debts, delivery fees) are stored as 64-bit integers in Algerian centimes ($1\text{ DZD} = 100\text{ centimes}$). Floating point math is strictly forbidden for money. |
| **INV-5** | Historical Cost Snapshot | Every sale item permanently snapshots the variant's cost price at the moment of sale (`cost_price_centimes`). Subsequent supplier price changes never rewrite historical margins. |
| **INV-6** | Dual-Layer Multi-Tenancy | Every query is scoped by `withTenant(context, tx)` in the application layer and backed by PostgreSQL `FORCE ROW LEVEL SECURITY`. Composite keys `(tenant_id, id)` ensure total tenant isolation. |
| **INV-7** | COD Order Flow | Online orders follow: `NEW` $\rightarrow$ `CALLING` $\rightarrow$ `CONFIRMED` $\rightarrow$ (Stock Reserved) $\rightarrow$ `PREPARING` $\rightarrow$ `SHIPPED` (Stock Deducted) $\rightarrow$ `DELIVERED` (COD Remitted) or `RETURNED` / `CANCELLED` (Stock Released). |
| **INV-8** | Delivery Decoupling | Delivery providers (Yalidine, ZR Express, Noest, Maystro) interact solely with the Order Service. Courier updates never mutate inventory directly. Flow: Courier $\rightarrow$ Order Service $\rightarrow$ Inventory Domain. |
| **INV-9** | Offline Independence | POS sales and thermal ticket printing (ESC/POS) must execute locally without internet dependency. Synced outbox updates the server idempotently upon reconnection. |
| **INV-10**| Dual Audit Architecture | 1. Business Audit Log (stock adjustments, price modifications, drawer closures, role changes).<br>2. Personal Data Processing Journal (`carnet automatisé` tracking access, modification, export, disclosure, and deletion of PII). |

---

## 1.1 Phase 03 — Mandatory Inventory Invariants

| Code | Invariant Name | Strict Definition |
| :--- | :--- | :--- |
| **INV-03-01** | Non-Negative OnHand | $OnHand \ge 0$. Negative stock is strictly prohibited by default. |
| **INV-03-02** | Non-Negative Reserved | $Reserved \ge 0$. Reservations cannot be negative under any condition. |
| **INV-03-03** | Reservation Ceiling | $Reserved \le OnHand$. Reserved stock cannot exceed physical on-hand stock. |
| **INV-03-04** | Authoritative Derived Available | $Available \equiv OnHand - Reserved$, where $Available \ge 0$. Available is strictly derived, never independent. |
| **INV-03-05** | Authoritative Ledger Event | Every stock mutation creates exactly one authoritative, immutable ledger event in `stock_movements`. |
| **INV-03-06** | Ledger Immutability | Stock ledger events are strictly append-only. `UPDATE` and `DELETE` on `stock_movements` are prohibited. |
| **INV-03-07** | Idempotent Reservation Release | Releasing an already released reservation is a safe no-op. Double-release never decrements reserved stock twice. |
| **INV-03-08** | Idempotent Reservation Consumption | Consuming an already consumed reservation is a safe no-op. Double-consumption never double-decrements. |
| **INV-03-09** | Idempotent Mutation | Replaying identical `operationId` returns cached result without duplicating mutations or ledger entries. |
| **INV-03-10** | Concurrency Safety | Concurrent operations on the same variant/location are serialized via mutex locks, preventing overselling. |
| **INV-03-11** | Cross-Tenant Isolation | Attempting to access, reserve, adjust, read, or transfer another tenant's inventory fails at server/domain/DB level. |
| **INV-03-12** | Historical Stock Integrity | Prior stock ledger records permanently retain snapshot costs, prices, and quantities; catalog edits never alter history. |
| **INV-03-13** | Inventory Architectural Boundary | No external domain (Catalog, POS, Orders, COD, Courier) mutates inventory tables directly. All pass through `InventoryService`. |
| **INV-03-14** | Atomic Transaction Boundary | Multi-step inventory operations are atomic. A failure mid-flight rolls back all inserts, updates, and deletes completely. |

---

## 1.2 Phase 04 — Mandatory POS & Cash Register Invariants

| Code | Invariant Name | Strict Definition |
| :--- | :--- | :--- |
| **INV-04-01** | Sale Immutability | Completed sale is immutable. Any modification attempt via `update()` throws `Sale Immutability Violation`. Corrections occur strictly via `VOIDED`, `REFUNDED`, or `PARTIALLY_REFUNDED`. |
| **INV-04-02** | Exact Sale Total | Sale total equals exact integer sum of SaleLines after discounts ($Total = Subtotal - DiscountTotal + TaxTotal$). Floating point currency math is prohibited. |
| **INV-04-03** | Exact Payment Equality | Payment total strictly equals sale total ($sum(payments) == sale.total$). Mixed tenders (Cash, Card, BaridiMob, Customer Credit) must sum exactly. Under-payment is rejected. |
| **INV-04-04** | Single Inventory Consumption | Every completed sale consumes inventory exactly once via `InventoryService.applyStockMovement`. Double-consumption is blocked. |
| **INV-04-05** | Exact Cash Drawer Movement | Every cash payment or cash refund creates exactly one `CashTransaction` record tracking net drawer movements ($amountPaid - changeDue$). |
| **INV-04-06** | Refund Quantity Ceiling | Refund quantity cannot exceed sold quantity per sale line ($refundedQty \le soldQty$). Over-refunds and duplicate line refunds are strictly rejected. |
| **INV-04-07** | Deletion Prohibition | Completed sales cannot be deleted or purged silently. Calling `delete('sales', id)` throws `Sale Immutability Violation`. |
| **INV-04-08** | POS Idempotency | Duplicate `operationId` cannot create duplicate sales, payments, inventory deductions, or cash transactions. Duplicate requests return identical cached receipt. |
| **INV-04-09** | Single Active Cash Session | Cash session cannot be double-opened for the same register. Opening an already open register throws `Cash Register Double Open Violation`. |
| **INV-04-10** | Closed Session Protection | Closed cash sessions cannot receive normal sales or transactions. Processing sales against closed sessions is rejected. |
| **INV-04-11** | Historical Snapshot Permanence | Historical sale lines preserve snapshots of `productName`, `variantName`, `sku`, `barcode`, `quantity`, `unitPrice`, `discount`, `tax`, `lineTotal`, and `costAtSale`. Catalog modifications or product archival never alter historical invoices. |
| **INV-04-12** | Cross-Tenant POS Isolation | Attempting to access, sell, refund, open, or close another tenant's register, session, sale, or product variant fails with `Tenant Isolation Violation`. |
| **INV-04-13** | Confirmed Receipt Identity | Receipt printing requires confirmed transaction identity. Printing tickets without an existing, committed sale is strictly prohibited. |
| **INV-04-14** | All-or-Nothing Atomicity | Failed sale transactions leave zero partial mutations. If payment validation, inventory consumption, or cash movement fails, all entities roll back completely. |

---

## 1.3 Phase 05 — Mandatory Procurement & Finance Invariants

| Code | Invariant Name | Strict Definition |
| :--- | :--- | :--- |
| **INV-05-01** | PO Stock Non-Mutation | Purchase Order creation does not mutate stock levels or create stock movements. |
| **INV-05-02** | Goods Receipt Stock Mutation | Only physical goods receipt mutates stock through `InventoryService.receiveStock()`. |
| **INV-05-03** | Receipt Quantity Ceiling | Received quantity cannot exceed allowed purchase quantity per line ($receivedQty \le orderedQty$). |
| **INV-05-04** | Auditable Receipt Cost | Every received quantity has an auditable cost snapshot recorded in `purchase_receipt_lines.unit_cost_centimes`. |
| **INV-05-05** | Sale Cost Snapshot Permanence | Historical sale cost snapshot (`cost_snapshot_centimes`) never changes regardless of catalog edits. |
| **INV-05-06** | Historical COGS Permanence | Historical COGS and Gross Profit never change because of current catalog cost modifications. |
| **INV-05-07** | Supplier Payment Ceiling | Supplier payment cannot exceed outstanding payable balance ($\sum payments \le \sum receipts - \sum returns$). |
| **INV-05-08** | Financial Idempotency | Duplicate financial `operationId` cannot create duplicate financial mutations or inventory movements. |
| **INV-05-09** | Expense Immutability | Expense posting is immutable except controlled void/reversal (`status = 'VOIDED'`). Deletion of posted expenses is prohibited. |
| **INV-05-10** | Purchase Return Ceiling | Purchase return quantity cannot exceed net received quantity per purchase line ($returnQty \le receivedQty - returnedQty$). |
| **INV-05-11** | Cross-Tenant Procurement Isolation | Cross-tenant access to suppliers, purchase orders, receipts, returns, payables, or expenses is strictly blocked. |
| **INV-05-12** | Domain Separation | Revenue, COGS, Inventory Assets, Supplier Liabilities, and Operating Expenses are strictly separated domains and metrics. |
| **INV-05-13** | Receipt Atomicity | Failed purchase receipt transaction leaves zero partial stock, cost, or payable mutations. |
| **INV-05-14** | Uniform Money Precision | All procurement, payment, expense, and profit amounts use system-wide integer centimes ($1\text{ DZD} = 100\text{ centimes}$). |
| **INV-05-15** | Snapshot-Based Reports | Historical financial reports are based strictly on transaction snapshots and event ledgers, never on current catalog values. |

---

## 1.4 Phase 06 — Mandatory COD & Online Order Invariants

| Code | Invariant Name | Strict Definition |
| :--- | :--- | :--- |
| **INV-06-01** | Order Non-Reservation | Creating an `OnlineOrder` strictly never reserves inventory. Stock remains unreserved in `NEW` and `PENDING_CONFIRMATION` states. |
| **INV-06-02** | Server-Authorized Reservation | Only server-authorized `CONFIRMED` state may trigger stock reservations via `InventoryService.reserveStock()`. |
| **INV-06-03** | Reservation Ownership Context | An inventory reservation belongs to exactly one `OnlineOrder` and `ProductVariant` context (`order_id`, `variant_id`). |
| **INV-06-04** | Order Creation Idempotency | Online order creation is idempotent. Duplicate requests with identical `operationId` return the cached order without duplicate records or reservations. |
| **INV-06-05** | Confirmation Idempotency | Order confirmation is idempotent. Replaying confirmation on an already confirmed/reserved order returns the cached result without creating duplicate reservations. |
| **INV-06-06** | Single Cancellation Release | Order cancellation releases held inventory reservations at most once. Repeated cancellation calls never double-release stock back to available. |
| **INV-06-07** | Unreserved Invariance | Refused or expired orders that never had active reservations never mutate inventory levels or movements upon transition. |
| **INV-06-08** | Anti-Forgery Protection | Client cannot forge order totals, discounts, delivery fees, or confirmation state. The server authoritatively calculates and enforces all amounts. |
| **INV-06-09** | OrderLine Price Immutability | Historical `order_items` snapshot `unit_price_centimes` permanently. Subsequent catalog price adjustments never alter historical order lines. |
| **INV-06-10** | Fee & COD Immutability | Historical delivery fee (`delivery_fee_centimes`) and `cod_amount_centimes` remain immutable on confirmed orders unless controlled administrative adjustment is audited. |
| **INV-06-11** | Cross-Tenant Order Isolation | Cross-tenant access to orders, order lines, customers, confirmation attempts, and reservations is strictly blocked at the domain boundary. |
| **INV-06-12** | Append-Only Confirmation Log | Every COD confirmation attempt is an immutable, append-only audit event in `confirmation_attempts`. Updates and deletions are prohibited. |
| **INV-06-13** | Personal Data Processing Journal | Every consultation, collection, extraction, and deletion of customer PII is logged in the automated Processing Journal (`carnet automatisé des opérations`). |
| **INV-06-14** | Order & Sale Separation | `OnlineOrder` and POS `Sale` remain strictly distinct domain entities. A new or confirmed online order is not recognized as revenue or completed sale until delivered. |
| **INV-06-15** | Courier Stock Decoupling | Courier adapters and parcel updates interact with order fulfillment and cannot mutate inventory directly without passing through `InventoryService`. |
| **INV-06-16** | All-or-Nothing Confirmation | A failed confirmation or stock shortage leaves zero partial reservations. If stock is insufficient, the transaction rolls back cleanly with zero stock held. |

---

## 1.5 Phase 07 — Mandatory Delivery & Shipment Invariants

| Code | Invariant Name | Strict Definition |
| :--- | :--- | :--- |
| **INV-07-01** | Shipment Tenant & Order Exclusivity | A Shipment belongs to exactly one Tenant and one Order. Cross-tenant order or shipment references are strictly rejected. |
| **INV-07-02** | Courier Inventory Decoupling | Provider adapters cannot directly mutate Inventory. All inventory operations remain strictly under `InventoryService` authority. |
| **INV-07-03** | Canonical State Machine Enforcement | Provider-specific status never bypasses canonical Shipment state machine validation. Illegal transitions (e.g. `DELIVERED -> ACCEPTED`) are strictly rejected. |
| **INV-07-04** | Shipment Creation Idempotency | Shipment creation is idempotent. Duplicate requests with identical `operationId` or `clientReference` return the existing shipment without creating duplicate parcels. |
| **INV-07-05** | Append-Only Provider Event Ledger | Webhooks and polling events are recorded in an append-only `provider_events` ledger. Duplicate provider events generate zero duplicate business effects. |
| **INV-07-06** | Historical Shipment Snapshot Immutability | Completed and historical Shipment records cannot be deleted. Deletion of shipments is strictly blocked. |
| **INV-07-07** | Carrier Credential Confidentiality | Provider credentials are encrypted at rest with AES-256-GCM and never reach the frontend, logs, or error responses. |
| **INV-07-08** | Safe Timeout Recovery | Provider timeout after remote creation is safely recoverable. Replaying the request with the same `operationId` or `clientReference` discovers the existing parcel and prevents duplicate shipments. |
| **INV-07-09** | Status Regression Protection | Old or out-of-order provider events cannot silently regress Shipment state. Terminal and progressive states like `DELIVERED` cannot revert to `IN_TRANSIT`. |
| **INV-07-10** | COD Amount Integrity | The COD amount cannot be silently changed by provider responses. In case of discrepancy, an `AMOUNT_MISMATCH` flag is raised for controlled resolution. |
| **INV-07-11** | Delivery Fee Snapshot Stability | Historical shipping fee snapshot (`shipping_fee_at_creation_centimes`) remains immutable and independent of subsequent tariff changes. |
| **INV-07-12** | Return Restock Decoupling | A returned shipment does not automatically restock inventory. Returned goods must enter an inspection workflow before restocking. |
| **INV-07-13** | Authoritative Return Restock | Only `InventoryService.receiveStock()` may perform return-to-stock mutations following explicit inspection approval. |
| **INV-07-14** | Cross-Tenant Shipment Isolation | Cross-tenant access to Shipments, Provider Accounts, Returns, and Remittances is impossible and strictly rejected at the domain boundary. |
| **INV-07-15** | Personal Data Transmission Auditing | Personal data transmission to a provider is auditable under Algerian Law 18-07 / 25-11 via automated `PERSONAL_DATA_TRANSMITTED` processing journal logs and statutory `TransferRecord`. |
| **INV-07-16** | Normalized Provider Error Taxonomy | Provider-specific errors are normalized into canonical error models without leaking internal secrets, tokens, or raw credentials. |
| **INV-07-17** | Bounded Idempotent Retry | Retryable provider failures (timeouts, 5xx, rate limits) use bounded exponential backoff with jitter; non-retryable validation errors abort immediately. |
| **INV-07-18** | Delivery & Settlement Decoupling | Delivered status does not imply COD settlement. Carrier collection and remittance settlement remain distinct from cash drawer operations. |
| **INV-07-19** | Collection & Settlement Auditability | Carrier collection and remittance settlement remain separately auditable with explicit discrepancy tracking. |
| **INV-07-20** | Pluggable Provider Polymorphism | Adding a new delivery provider adapter requires no modification to Order, Inventory, or Cash domains. |

---

## 1.6 Phase 08 — Mandatory Offline Sync, Queue & Conflict Invariants

| Code | Invariant Name | Strict Definition |
| :--- | :--- | :--- |
| **INV-08-01** | Globally Unique Operation Identity | Every offline-capable operation must have a globally unique `operationId` bound to `tenantId` and `deviceId`. |
| **INV-08-02** | Exactly-Once Business Mutation | The same `operationId` produces at most one business effect on the authoritative server state. |
| **INV-08-03** | Tampered Payload Replay Rejection | An identical `operationId` submitted with a different request hash is rejected with `IDEMPOTENCY_KEY_REUSE`. |
| **INV-08-04** | Authoritative Server Hierarchy | $LOCAL \ne SOURCE\ OF\ TRUTH$; the server remains authoritative over inventory, cash, payments, and permissions. |
| **INV-08-05** | Durable Queue Crash Survival | The local outbox queue survives browser crashes, forced process exits, and device reboots without data loss. |
| **INV-08-06** | Zero Silent Drops | Enqueued operations are never silently dropped; they remain in outbox until authoritatively acknowledged or permanently flagged. |
| **INV-08-07** | Bounded Idempotent Retry | Transient failures (5xx, timeouts, 429) use exponential backoff with jitter and max attempt limits. |
| **INV-08-08** | Visible Permanent Failures | Non-retryable errors (401/403, validation errors, revoked device) remain visible and auditable as `PERMANENT_FAILURE`. |
| **INV-08-09** | Offline Tenant Boundary | Offline POS cannot bypass multi-tenant isolation; cross-tenant operations are strictly blocked. |
| **INV-08-10** | Offline RBAC Enforcement | Offline POS and sync operations cannot bypass role-based access control; manager-only operations require manager privileges. |
| **INV-08-11** | Capability Matrix Enforcement | Offline operations are strictly restricted to authorized types (`POS_SALE`, `PAYMENT_RECORD`, `RECEIPT_GENERATION`, `CASH_SESSION_LOCAL_STATE`). Unsupported mutations cannot be queued offline. |
| **INV-08-12** | Duplicate Sync Invariance | A duplicate sync request cannot duplicate Sale, Payment, Cash, or Inventory effects on the server. |
| **INV-08-13** | Dependency Ordering Safety | Out-of-order sync operations cannot violate dependencies (`dependsOnOperationId`). Missing dependencies yield `DEPENDENCY_MISSING` conflict. |
| **INV-08-14** | Historical Snapshot Immutability | Conflict resolution cannot rewrite or mutate historical transaction snapshots. |
| **INV-08-15** | No Financial Last-Write-Wins | Financial and stock conflicts are never silently resolved by last-write-wins or client-wins. |
| **INV-08-16** | Non-Negative Inventory Invariance | Stock conflicts cannot drive server inventory negative; insufficient stock yields `STOCK_CONFLICT` and `PENDING_REVIEW`. |
| **INV-08-17** | Revoked Device Mutation Block | Revoked POS devices cannot create new server-side mutations; operations are rejected with `DEVICE_REVOKED`. |
| **INV-08-18** | Local Receipt Deduplication | Local offline receipt printing cannot produce duplicate financial transactions upon server synchronization. |
| **INV-08-19** | Processing Journal Deduplication | Personal data processing journal entries are not duplicated by network transport retries. |
| **INV-08-20** | Sync Credential & PII Sanitization | Sync telemetry logs do not expose passwords, API tokens, or unnecessary customer PII. |
| **INV-08-21** | Durable Server Acknowledgements | Server acknowledgements are stored in an append-only `processed_operations` ledger for replay safety. |
| **INV-08-22** | Recoverable Local Outbox Leases | Multi-tab outbox claims use time-bounded leases (`leaseExpiresAt`) preventing concurrent processing while allowing crash recovery. |
| **INV-08-23** | Device Tenant Binding | POS devices are strictly tenant-bound; attempting to sync a device against a different tenant is rejected. |
| **INV-08-24** | Explicit Offline Capability Matrix | Offline capability is defined explicitly per operation type and rejected at the local queue boundary if unauthorized. |
| **INV-08-25** | Bounded Stock Allowance Budget | Offline stock consumption is bounded by server-authorized stock reservation budgets per device/register. |

---

## 1.7 Phase 09 — Mandatory Dashboard, Reporting & Analytics Invariants

| Code | Invariant Name | Strict Definition |
| :--- | :--- | :--- |
| **INV-09-01** | Read-Only Reporting Boundary | Reports never mutate transactional business state (no direct updates or deletes to sales, stock, orders, costs, or payables). |
| **INV-09-02** | Canonical Metric Definition | Every canonical metric has exactly one authoritative documented definition and version. Recalculations across pages cannot diverge. |
| **INV-09-03** | Contextual Tenant Boundary | Tenant isolation applies to every report, query, read model, and export. Tenant ID is strictly derived from session context. |
| **INV-09-04** | Historical Financial Integrity | Financial reports use canonical historical transaction snapshots (`cost_snapshot_centimes`), never live current catalog prices. |
| **INV-09-05** | Historical COGS Stability | Historical COGS is never recalculated from current variant cost price changes. |
| **INV-09-06** | Net Refund Accountability | Refunds and voids are reflected exactly once in net revenue and profit calculations. |
| **INV-09-07** | Idempotent Event Ingestion | Reporting events are idempotent; replaying identical event ID produces zero duplicate numbers in read models. |
| **INV-09-08** | Full Read-Model Rebuildability | Read models are completely rebuildable from canonical transactional sources without data loss. |
| **INV-09-09** | Rebuild Total Invariance | Read-model rebuild produces reconciled totals identical to transactional sources down to the centime. |
| **INV-09-10** | Drift Detectability | Reporting drift is detectable via automated reconciliation; critical drift blocks green reporting health status. |
| **INV-09-11** | Tenant-Aware Timezone | Timezone is tenant-aware (default `Africa/Algiers`) for daily and periodic report boundaries while storage remains pure UTC. |
| **INV-09-12** | Non-Misleading Zero Denominators | Zero denominators never produce misleading percentages (`+∞%` or `0%` when undefined); return `N/A` or `New`. |
| **INV-09-13** | Strict COD Logistics Decoupling | Delivered, Collected, and Settled remain distinct metrics. Carrier COD collections never credit physical cash register drawers automatically. |
| **INV-09-14** | Procurement vs Expense Separation | Supplier Payables (inventory asset investments) and Operating Expenses remain strictly distinct concepts. |
| **INV-09-15** | Valuation vs COGS Separation | Current stock valuation ($OnHand 	imes WAC$) and historical COGS remain strictly separated concepts. |
| **INV-09-16** | PII Export Control & Journaling | PII exports are role-permission controlled (Manager/Owner only) and automatically logged to the statutory Processing Journal. |
| **INV-09-17** | Memory-Safe Streaming Exports | Large exports enforce row budgets and stream/chunk lines without requiring unbounded application memory. |
| **INV-09-18** | Archived Entity Permanence | Archived products, variants, or categories do not silently disappear from historical reporting queries. |
| **INV-09-19** | Immutable Report Snapshots | Report snapshots identify their metric-definition version, store a SHA-256 data hash, and are strictly immutable. |
| **INV-09-20** | User Tenant Boundary Rejection | No report endpoint accepts a user-supplied `tenantId` query parameter as an authority boundary. |

---


---

## 1.8 Phase 10 — Mandatory Integrations & Public API Invariants

| Code | Invariant Name | Strict Definition |
| :--- | :--- | :--- |
| **INV-10-01** | Domain Service Invocation | External integrations cannot bypass domain services (Adapter -> Domain Service, never Platform -> DB). |
| **INV-10-02** | BoutiqFlow Authority | BoutiqFlow remains authoritative for product identity, inventory levels, costs, cash, and financial history. |
| **INV-10-03** | Tenant-Bound Integrations | Every integration account, credential, and mapping is strictly bound to authenticated tenant context. |
| **INV-10-04** | Primary Identity Integrity | External identifiers are mapped in integration_mappings and never replace internal primary identities (UUIDv7). |
| **INV-10-05** | Idempotent Webhook Events | External webhook event logging is append-only and deduplicated via unique (integration_id + external_event_id). |
| **INV-10-06** | Idempotent Order Import | External order import is idempotent; multiple webhooks or polling events yield exactly 1 logical OnlineOrder. |
| **INV-10-07** | Idempotency Key Tamper Rejection | Reusing an Idempotency-Key with an altered payload is strictly rejected with 409 IDEMPOTENCY_KEY_REUSE. |
| **INV-10-08** | Two-Phase Outbox Decoupling | Third-party API outages or 500s never roll back committed local sales or inventory transactions. |
| **INV-10-09** | Replay-Safe Outbox Processing | Outbox event processing is replay-safe and recovers via remote lookup if a worker crashes post-dispatch. |
| **INV-10-10** | Unidirectional Inventory Projection | Inventory sync is BoutiqFlow -> External Projection. External events cannot overwrite local stock without reconciliation. |
| **INV-10-11** | Historical Price Stability | External catalog price changes never silently rewrite completed historical transaction records. |
| **INV-10-12** | Refund History Preservation | External refunds and returns never delete local transaction history or bypass inspection workflows. |
| **INV-10-13** | Provider Adapter Isolation | Provider-specific logic and schemas remain strictly encapsulated inside integration adapters. |
| **INV-10-14** | Explicit Capability Assertion | Adapters declare capabilities explicitly; unsupported operations fail with CAPABILITY_NOT_SUPPORTED. |
| **INV-10-15** | Credential Encryption at Rest | Third-party access tokens and API secrets are AES-256-GCM encrypted at rest and never exposed to UI or logs. |
| **INV-10-16** | Hashed & Revocable API Keys | Public API keys use SHA-256 hashed secrets at rest and can be revoked immediately with zero latency. |
| **INV-10-17** | Public API Tenant Boundary | Public API authentication context dictates tenant boundary; user-supplied tenantId parameters are rejected. |
| **INV-10-18** | Public Mutation Idempotency | All state-changing Public API mutations accept Idempotency-Key and return identical cached responses on replay. |
| **INV-10-19** | Webhook Cryptographic Verification | Inbound webhook authenticity is verified via HMAC-SHA256 signatures prior to event processing. |
| **INV-10-20** | Webhook Business Non-Duplication | Replaying already processed webhook events produces zero duplicate side effects in the domain. |
| **INV-10-21** | Signed Outbound Webhooks | Outbound webhooks delivered to subscribers are cryptographically signed using HMAC-SHA256. |
| **INV-10-22** | Bounded Webhook Retries | Failing webhook destinations use bounded exponential backoff and are automatically disabled after 5 failures. |
| **INV-10-23** | Strict Webhook SSRF Prevention | Webhook destinations targeting localhost, private subnets (RFC 1918), or cloud metadata services are blocked. |
| **INV-10-24** | Online Payment Separation | Orders paid online via external gateways record payment evidence without mutating cash register drawers. |
| **INV-10-25** | Statutory International Transfer Log | Connecting external platforms outside Algeria automatically generates a statutory Law 25-11 TransferRecord. |
| **INV-10-26** | Version-Controlled External APIs | External API versions (Shopify GraphQL 2025-01, WooCommerce REST v3) are explicit and upgrade-controlled. |
| **INV-10-27** | Safe Failure Boundary | Read or network failures on external platforms never silently translate into successful domain mutations. |
| **INV-10-28** | Strict State Machine Adherence | External order or fulfillment statuses cannot bypass local domain state machine transition guards. |


---

## 1.9 Phase 11 — Mandatory Privacy, Compliance & Data Governance Invariants

| Code | Invariant Name | Strict Definition |
| :--- | :--- | :--- |
| **INV-11-01** | Documented Purpose Mandatory | Every personal-data processing activity has a documented, non-empty purpose linked to statutory taxonomy. |
| **INV-11-02** | Configured Legal Basis | Every processing activity has an explicit, configured legal-basis status derived from law or formal legal review. |
| **INV-11-03** | Explicit Role Representation | Controller, Processor, Subprocessor, and Recipient roles are explicitly defined per processing activity. |
| **INV-11-04** | Tenant-Scoped Processing Register | The Processing Register is strictly isolated per tenant and auditable by authorized compliance officers. |
| **INV-11-05** | Independent Processing Journal | The automated Processing Journal (Art. 41 bis 3) is strictly independent from the business audit log. |
| **INV-11-06** | Append-Only Journal Immutability | Processing Journal entries cannot be updated or deleted; corrections are appended as CORRECTION_EVENT records. |
| **INV-11-07** | Cryptographic Journal Chaining | Processing Journal maintains sequence numbers and SHA-256 hash chaining; sequence gaps and tampering are detectable. |
| **INV-11-08** | Explicit Retention Policy | Retention policies are explicitly defined with duration and review status or flagged LEGAL_REVIEW_REQUIRED. |
| **INV-11-09** | Legal Hold Immunity | Active Legal Holds freeze records unconditionally; retention execution jobs cannot delete or anonymize held data. |
| **INV-11-10** | Mandatory DPIA Gate | High-risk processing activities requiring DPIA cannot transition to ACTIVE status without an APPROVED DPIA. |
| **INV-11-11** | Identity Verification Gate | Data subject rights requests (ACCESS, RECTIFICATION) require identity verification before disclosure or update. |
| **INV-11-12** | Immutable Financial History | Data subject rights requests cannot alter immutable historical financial ledger records, prices, or costs. |
| **INV-11-13** | Documented Data Breach Register | Every security incident involving personal data is documented with affected categories, counts, and remediation. |
| **INV-11-14** | Immediate Processor-to-Controller Notice | When acting as Processor, BoutiqFlow notifies the Merchant Controller immediately upon becoming aware of a breach. |
| **INV-11-15** | Statutory 5-Day Authority Deadline | ANPDP regulatory notification deadline is calculated as exactly 5 calendar days from the moment of breach awareness. |
| **INV-11-16** | Mandatory Delay Justification | Regulatory notifications submitted past the 5-day statutory window strictly require a documented delay reason. |
| **INV-11-17** | High-Risk Subject Notification | High-risk personal data breaches mandate plain-language bilingual (Arabic & French) notification to affected persons. |
| **INV-11-18** | Explicit TransferRecord State | Cross-border international transfers must have an explicit TransferRecord specifying country, recipient, and safeguards. |
| **INV-11-19** | Runtime Transfer Interceptor | Outbound transmissions to foreign destinations are blocked at runtime if TransferRecord status is REVIEW_REQUIRED. |
| **INV-11-20** | Super Admin Privacy Boundary | SaaS Super Admins have zero default browse access to tenant customer PII without an active support session. |
| **INV-11-21** | Permission-Controlled PII Exports | Compliance evidence exports are restricted to OWNER, MANAGER, or DPO roles and logged to the processing journal. |
| **INV-11-22** | Subprocessor Inventory | All third-party subprocessors are inventoried with operational purpose, data categories, and location. |
| **INV-11-23** | Versioned DPA Tracking | Data Processing Agreements are version-tracked with explicit status (UNDER_REVIEW, APPROVED) without legal presumption. |
| **INV-11-24** | PII Field Classification | All personal fields are classified (PUBLIC, INTERNAL, PERSONAL, SENSITIVE, HIGH_RISK, SECRET) before production use. |
| **INV-11-25** | Automated Privacy CI Gate | CI pipelines automatically scan schema and AST to reject any new PII field lacking purpose, retention, or access policy. |
| **INV-11-26** | Auditable Evidence Packages | Compliance export packages are cryptographically hashed (SHA-256) and stored in immutable compliance_evidence_exports. |
| **INV-11-27** | Tenant Isolation on Governance | Compliance registers, journals, breaches, DPIAs, and privacy requests are strictly bound to authenticated tenant context. |
| **INV-11-28** | No False Legal Approval | Controls requiring formal legal review cannot be presented in code or UI as legally approved or certified. |
| **INV-11-29** | Data Backup Governance | Database backup snapshots are tracked with encryption, residency region, retention policies, and restore audits. |
| **INV-11-30** | Log Redaction & Secret Hygiene | Application, error, and integration logs strictly scrub PII, passwords, API tokens, and webhook secrets. |

### Phase 12 Invariants: SaaS Plans, Billing, Tenant Lifecycle & Abuse Prevention
| Code | Name | Description |
|---|---|---|
| **INV-12-01** | Authoritative Subscription Boundary | Frontend cannot define authoritative subscription state or plan; derived strictly from database records. |
| **INV-12-02** | Server-Side Entitlement Enforcement | Entitlements and feature access are strictly enforced server-side via EntitlementEngine. |
| **INV-12-03** | Plan Version Price Immutability | Plan versions preserve historical billing prices permanently; price changes create new versions without mutating past invoices. |
| **INV-12-04** | Invoice Immutability After Issuance | Invoices are strictly immutable once issued; total, subtotal, tax, currency, and line items cannot be modified. |
| **INV-12-05** | Controlled Invoice Reversals | Invoice corrections use controlled reversal mechanisms (Credit Notes, Debit Notes, formal voiding) rather than direct row mutation. |
| **INV-12-06** | Webhook Processing Idempotency | The same payment provider webhook cannot produce duplicate business effects or duplicate credit extensions. |
| **INV-12-07** | Payment Verification Against Invoices | Payment amount and currency from external webhooks are strictly verified against expected invoice billing state before activation. |
| **INV-12-08** | Idempotency Key Conflict Protection | The same idempotency key with different payload is rejected with a 409 conflict error. |
| **INV-12-09** | Explicit Subscription State Transitions | Subscription state transitions follow an audited state machine; direct activation from SUSPENDED requires validated payment. |
| **INV-12-10** | Idempotent Trial Provisioning | Trial and subscription provisioning is idempotent; network retries never create duplicate trials or subscriptions. |
| **INV-12-11** | Idempotent Tenant Provisioning | Tenant signup and onboarding provisioning is replay-safe; retries return existing tenant without creating duplicates. |
| **INV-12-12** | Privacy-Aware Rate Limiting | Trial abuse controls and OTP verification enforce rate limits, resend cooldowns, and attempt limits without excessive fingerprinting. |
| **INV-12-13** | Multi-Factor Abuse Evaluation | Isolated risk signals are never treated as conclusive proof of fraud; decision engine uses ALLOW, CHALLENGE, LIMIT, REVIEW, BLOCK. |
| **INV-12-14** | Suspended Tenant Mutation Block | Suspended and read-only tenants cannot perform unauthorized operational mutations (POST sales, orders, users, integrations). |
| **INV-12-15** | Operational Data Preservation | Billing suspension and payment failures never delete operational business data (inventory, sales, customers, products). |
| **INV-12-16** | Non-Destructive Plan Downgrades | Plan downgrades with usage exceeding new limits never silently delete users, products, or data; violation status is flagged. |
| **INV-12-17** | Deletion Blockers & Legal Hold | Tenant deletion is strictly blocked if active Legal Holds, open personal data breaches, or billing disputes exist. |
| **INV-12-18** | Documented Admin Overrides | Admin overrides and comp access require documented business reason, actor, ticket reference, time-bounded scope, and audit logging. |
| **INV-12-19** | Provider Credential Isolation | Payment provider credentials and API keys are stored encrypted and never exposed to frontend clients or logs. |
| **INV-12-20** | Zero Raw Card Data Storage | Raw credit/debit card numbers (PAN, CVV) are strictly prohibited from entering or persisting in BoutiqFlow databases. |
| **INV-12-21** | Billing Reconciliation Integrity | Daily reconciliation audits provider transactions against internal records, recovering missing webhooks and flagging mismatches. |
| **INV-12-22** | Entitlement Cache Invalidation | Entitlement caches have short TTL and are immediately invalidated on subscription status change, plan change, or override grant. |
| **INV-12-23** | Cross-Tenant Billing Isolation | Invoices, payments, subscriptions, and usage records are strictly isolated by tenant ID; cross-tenant access is impossible. |
| **INV-12-24** | Idempotent Usage Metering | Usage metering events are idempotent and aggregate counters are fully rebuildable from canonical event streams. |
| **INV-12-25** | Hard Limit Domain Blocking | Hard plan limits (e.g. MAX_USERS) are enforced server-side and block excess resource creation with PLAN_LIMIT_REACHED. |
| **INV-12-26** | Non-Blocking Soft Limits | Soft plan limits (e.g. API requests) issue warnings without prematurely blocking legitimate authorized boutique operations. |
| **INV-12-27** | Notification Delivery Decoupling | Customer notification delivery failures do not determine billing truth; subscription states remain authoritative. |
| **INV-12-28** | Zero Trust on Untrusted Payment Claims | External payment success is never trusted based on client claims without server-side verification against invoice and provider. |
| **INV-12-29** | Immutable Historical Invoicing | Subscription state changes, upgrades, or cancellations cannot retroactively mutate historical invoices or credit notes. |
| **INV-12-30** | Idempotent Lifecycle Transitions | Tenant lifecycle state machine transitions are idempotent, audited, and server-controlled. |

### Phase 13 Invariants: Security Hardening, Chaos & Disaster Recovery
| Code | Name | Description |
|---|---|---|
| **INV-13-01** | Patched Database Version | Production database runs a patched supported PostgreSQL release (>= 16.15/17.11/18.6) safe from CVE-2026-14666. |
| **INV-13-02** | RLS Policy Invalidation | RLS remains effective after role, membership, or session state changes; stale cached policies never grant unauthorized access. |
| **INV-13-03** | Zero Exploitable Dependencies | No known exploitable critical vulnerability remains at production release. |
| **INV-13-04** | Secret Hygiene at Rest & Git | No production secret, private key, or payment token exists in source code, build artifacts, git history, or logs. |
| **INV-13-05** | Pooled Connection Isolation | Cross-tenant access remains impossible under shared database connection pooling; session contexts clear completely. |
| **INV-13-06** | Authentication Barrier | Authentication failure cannot become authorization success; account lockouts protect against credential stuffing. |
| **INV-13-07** | Fail-Closed Authorization | Authorization failure cannot fail open; missing, corrupted, or unresolvable permissions default strictly to DENY. |
| **INV-13-08** | Provider Failure Non-Corruption | External provider failure (500s, timeouts, network partition) cannot corrupt or roll back local committed business state. |
| **INV-13-09** | Worker Crash Idempotency | Worker crash at any execution phase cannot duplicate durable business effects (sales, stock reservations, payments). |
| **INV-13-10** | Quarantined Queue Corruption | Queue corruption or malformed payloads cannot silently discard critical events; events are quarantined into Dead Letter Queue. |
| **INV-13-11** | Pre-Restore Checksum Validation | Backup integrity and cryptographic checksums are verified before executing any restoration. |
| **INV-13-12** | Tested Recovery Path | At least one empirically tested recovery path exists for all critical business data (Point-In-Time and full restore). |
| **INV-13-13** | Post-Recovery Tenant Isolation | Restoration preserves multi-tenant isolation; Tenant A can never view or access Tenant B data after recovery. |
| **INV-13-14** | Financial History Preservation | Disaster recovery preserves complete financial history without balance distortion or floating-point rounding errors. |
| **INV-13-15** | Inventory Invariant Preservation | Disaster recovery preserves physical stock invariants: on_hand >= 0, reserved >= 0, available = on_hand - reserved. |
| **INV-13-16** | Journal Chain Preservation | Recovery preserves Processing Journal cryptographic hash chains without introducing broken sequence links. |
| **INV-13-17** | Zero Critical Integrity Drift | Critical data integrity drift detected by IntegrityCheckJob strictly blocks production release. |
| **INV-13-18** | High-Risk Rate Limiting | Rate limiting protects high-risk endpoints (login, OTP, signup, payments, webhooks, exports) against abuse. |
| **INV-13-19** | Bounded Resource Exhaustion | Resource consumption is strictly bounded against oversized payloads and deeply nested malicious structures. |
| **INV-13-20** | Webhook & Replay Protection | Webhook and replay attacks cannot duplicate business effects or produce duplicate invoice credits. |
| **INV-13-21** | Offline Queue Tamper Defense | Offline queue tampering cannot bypass server validation; modified payloads are detected and rejected. |
| **INV-13-22** | Billing Fraud Entitlement Block | Billing fraud, fake webhooks, and amount tampering cannot grant unauthorized subscription entitlements. |
| **INV-13-23** | Local State Machine Authority | External provider status updates cannot bypass or violate local authoritative business state machines. |
| **INV-13-24** | Sanitized Security Logging | Security and privacy logs scrub all passwords, session tokens, API keys, and unnecessary customer PII. |
| **INV-13-25** | Time-Bounded Break-Glass Access | Emergency break-glass and support access sessions expire automatically and are logged with mandatory justification. |
| **INV-13-26** | Documented Security Exceptions | Security exceptions are documented, scoped, time-bound, and require formal security and legal approval. |
| **INV-13-27** | Measured Empirical RPO & RTO | Disaster recovery establishes empirically measured RPO (< 1 min) and RTO (< 3 min) under automated validation. |
| **INV-13-28** | Post-Restore Integrity Audit | Restore success strictly requires running and passing the complete post-restore data integrity audit. |
| **INV-13-29** | Production Anomaly Alerting | Production health monitoring detects and alerts in real-time on critical integrity drifts, security anomalies, and outages. |
| **INV-13-30** | Zero NO-GO Release Blockers | No unresolved critical GO/NO-GO blocker is permitted at production release. |

### 1.15. Phase 14: Final Production Audit & Release Invariants (Production Certification)

| Invariant ID | Title | Rule & Architectural Enforcement |
| :--- | :--- | :--- |
| **INV-14-01** | Immutable Release Identity | A production release is uniquely identified by immutable version/build/commit metadata. |
| **INV-14-02** | Controlled Build Reproducibility | Production artifacts are generated from controlled source and dependency state with SBOM hashing. |
| **INV-14-03** | Fail-Closed Production Config | Production configuration fails closed when required security settings are missing or insecure. |
| **INV-14-04** | Staging Secret Prohibition | Production secrets are not inherited from development or staging environments. |
| **INV-14-05** | Production URL Integrity | All critical external URLs point strictly to production-approved HTTPS destinations. |
| **INV-14-06** | Zero-Downtime Safe Migrations | Database migrations are versioned, reversible, and enforce expand/contract patterns. |
| **INV-14-07** | Post-Migration Tenant Isolation | Post-migration tenant isolation and RLS policies remain 100% intact. |
| **INV-14-08** | Post-Migration Financial History | Post-migration financial history and historical transaction snapshots remain immutable. |
| **INV-14-09** | Post-Migration Inventory Integrity | Post-migration inventory ledger balances and available calculations remain strictly consistent. |
| **INV-14-10** | Post-Migration Journal Integrity | Post-migration Automated Processing Journal cryptographic hash chain integrity remains intact. |
| **INV-14-11** | Tenant-Scoped Cache Namespacing | Cache keys cannot leak tenant data; all keys strictly incorporate tenant identifier prefixes. |
| **INV-14-12** | Async Worker Isolation | Asynchronous jobs cannot bypass tenant isolation or execute forged tenant payloads. |
| **INV-14-13** | RBAC Non-Bypass | Releases cannot bypass RBAC matrix boundaries through configuration or feature flags. |
| **INV-14-14** | Privacy Control Non-Bypass | Releases cannot bypass privacy controls, data masking, or legal holds through feature flags. |
| **INV-14-15** | Vulnerability Release Block | Any known exploitable critical vulnerability strictly blocks production release. |
| **INV-14-16** | Unexplained Drift Release Block | Any critical unexplained financial or inventory drift strictly blocks production release. |
| **INV-14-17** | Pre-Release Backup Proof | Backup integrity, hash verification, and encryption are proven before production approval. |
| **INV-14-18** | Pre-Release Restore Proof | Restore procedure has been empirically tested and verified before production approval. |
| **INV-14-19** | Pre-Release Rollback Proof | Automated rollback procedure has been validated before production approval. |
| **INV-14-20** | Measured SLA Qualification | RPO/RTO metrics are explicitly labeled as measured in test environment vs guaranteed production SLA. |
| **INV-14-21** | Canary Criteria Definition | Phased canary deployment has explicit success and rollback criteria across tenant cohorts. |
| **INV-14-22** | Mandatory Post-Deploy Reconcile | Post-deployment reconciliation across all business ledgers is mandatory before GA promotion. |
| **INV-14-23** | Independent Technical vs Legal Gate | Technical GO/NO-GO is distinct from formal statutory legal sign-off. |
| **INV-14-24** | Legal Review Transparency | Privacy and legal-review items cannot be auto-marked approved by tests or code. |
| **INV-14-25** | Known Limitations Disclosure | Production release documentation transparently discloses all known limitations and boundaries. |
| **INV-14-26** | Production Failure Runbooks | Production operational runbooks exist for critical failure modes, outages, and rotations. |
| **INV-14-27** | Tested Alert Delivery | Monitoring and alert delivery are verified empirically via synthetic dispatch, not merely configured. |
| **INV-14-28** | Production Credential Sanitization | Production test and sandbox credentials are removed, rotated, or strictly isolated. |
| **INV-14-29** | Integration Version Audit | External integration API versions, webhook contracts, and schemas are recorded and reviewable. |
| **INV-14-30** | Unanimous Critical Pillar Gate | Final GO decision requires all mandatory critical domains to be certified GREEN. |
| **INV-14-31** | No Unit Test Override | A NO-GO decision cannot be overridden by passing unit tests alone. |
| **INV-14-32** | Scoped Production Exceptions | Every production operational exception has an assigned owner, mitigation, and expiry date. |
| **INV-14-33** | Immutable Evidence Preservation | Final release evidence (SBOM, scans, manifests, audit logs) is preserved immutably. |
| **INV-14-34** | Automated Canary Rollout Halt | A failed canary metric or drift event immediately halts rollout before full deployment. |
| **INV-14-35** | Post-Incident Readiness Re-Audit | Production readiness is reassessed from scratch after any critical post-release incident. |

## 2. Platform Layering Architecture

```
Layer 5: Compliance & Privacy (Register of Processing, Processing Journal, Breach Management, Transfer Controls)
                           ▲
Layer 4: SaaS Management (Tenancy, Plans: Starter 1,490 / Pro 2,990 / Business 5,990 DZD, BaridiMob/CCP, Chargily Pay V2)
                           ▲
Layer 3: Omnichannel Connectors (Shopify, WooCommerce, Generic REST API, WhatsApp with Unmapped Items Triage)
                           ▲
Layer 2: Algerian Commerce & Delivery (COD Confirmation, 58 Wilayas, Yalidine, ZR Express, Noest, Maystro)
                           ▲
Layer 1: Offline PWA & Hardware Abstraction (IndexedDB Outbox, ESC/POS Local Receipt Printing)
                           ▲
Layer 0: Core Domain (POS Caisse, Single Inventory Ledger, Clothing Size x Color Matrix, Real P&L Expenses)
```

---

## 3. Strict Operating Rules for Agents
1. **Evidence-Based Completion:** No task is marked complete without executed automated tests and logged proofs in `docs/VERIFY.md`.
2. **Phase Boundary Enforcement:** Follow `/agents/PHASE-XX.md` sequentially. Never skip phases or start Phase $N+1$ until Phase $N$ passes all tests and audits.
3. **No Phantom Integrations:** Do not claim automated SATIM card recurring billing without certified web-merchant contracts. Do not claim "100% legal compliance" without independent Algerian legal audit.
