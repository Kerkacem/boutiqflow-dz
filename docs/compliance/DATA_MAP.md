# BoutiqFlow DZ — Personal Data Inventory & Location Map

This data map documents where Personal Identifiable Information (PII) resides across the BoutiqFlow multi-tenant platform, its operational purpose, retention rules, security controls, and transfer statuses.

## 1. Storage & Processing Locations

| Location | Component | Data Categories | Operational Purpose | Default Retention | Encryption (Rest / Transit) | Access Control (RBAC) | External Destination | Transfer Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Database** | PostgreSQL / SQLite | Identity, Contact, Address, Order Data, Debt Ledger | Core retail transactional processing, customer orders, and store operations | Active tenure + configured retention policy | AES-256-GCM / TLS 1.3 | Tenant RLS + Role Permissions (Owner, Manager, Cashier, Accountant) | None (Primary Host) | LOCAL |
| **Cache** | Redis / In-Memory | Session Tokens (hashed), Ephemeral Order Summaries | Rapid POS response, rate limiting, and session verification | Session lifetime (max 12 hours) | Memory Isolation / TLS | System / Internal Service only | None | LOCAL |
| **Application Logs** | Console / Rotating Files | Redacted Operational Metadata | Debugging, error monitoring, and performance telemetry | 30 days | Redacted / TLS | Platform DevOps (PII strictly scrubbed via log redaction filter) | Internal log collector | LOCAL |
| **Processing Journal** | `processing_journal` Table | Actor ID, Timestamp, Operation, Subject ID, Purpose, IP, User Agent | Statutory compliance (Art. 41 bis 3 Law 25-11), internal security verification | Configured policy (`LEGAL_REVIEW_REQUIRED`) | Append-Only, Cryptographic Chaining / TLS | DPO, Tenant Owner, Compliance Auditor | None | LOCAL |
| **Backups** | Daily Encrypted Dump Files | Full snapshot of database tables | Disaster recovery, business continuity | 90 days rotating snapshot | AES-256-GCM (Dedicated backup key) / TLS | Infrastructure Admin only | Secure Backup Bucket | CONFIGURED_REGION |
| **Offline POS** | IndexedDB (Client Browser / Tablet) | Active Register Session, Seeded Catalog, Local Pending Sales | Uninterrupted offline cashier checkout in physical retail boutique | Purged upon successful sync (max 7 days cache) | Web Crypto / IndexedDB sandbox | Cashier assigned to register terminal | Local device | LOCAL_OFFLINE |
| **Exports** | Generated CSV / XLSX / PDF | Customer contact info, order summaries, sales receipts | Merchant bookkeeping, compliance evidence, tax reporting | Ephemeral download URL (auto-expires in 24 hours) | Temporary file encryption / TLS | Owner / Manager only (Cashier masked/denied) | Merchant Local Download | LOCAL |
| **Courier Integrations** | Yalidine, ZR Express, Noest, Maystro APIs | Customer Name, Phone, Delivery Address, Wilaya, COD Amount | Package delivery fulfillment and cash collection across 58 wilayas | Managed by carrier per transit contract | API Key encrypted at rest / HTTPS TLS 1.3 | Fulfillment Agent / Automated Webhook | Algerian Courier Platforms | DOMESTIC_TRANSFER |
| **Shopify** | Shopify GraphQL Admin API | Order Items, Customer Name, Shipping Address, Total, Phone | Omnichannel order import and stock projection | Synced to BoutiqFlow order record | Access Token encrypted with AES-256-GCM / TLS 1.3 | Integration Worker | Shopify Inc. (Canada / Cloud) | STATUTORY_TRANSFER_RECORD |
| **WooCommerce** | WooCommerce REST API v3 | Order Items, Customer Name, Shipping Address, Phone | Omnichannel order import and stock projection | Synced to BoutiqFlow order record | Consumer Secret encrypted with AES-256-GCM / TLS 1.3 | Integration Worker | Merchant-Hosted WordPress | TRANSFER_RECORD_REVIEW |
| **Email / SMS / WhatsApp** | Notification Gateway | Recipient Phone/Email, Tracking Number, Order Status | Customer delivery notifications, COD confirmation links | 30 days delivery log | TLS 1.3 | Notification Worker | Algerian Telecom / Meta Gateway | CONFIGURED_PROVIDER |
| **Customer Support** | Support Portal / Break-Glass | Customer Profile, Order Details (time-bound) | Platform technical assistance and troubleshooting | Session duration (max 4 hours, strictly audited) | AES-256-GCM / TLS 1.3 | Super Admin via `JUSTIFIED_SUPPORT_ACCESS` | Super Admin Browser | AUDITED_BREAK_GLASS |

---

## 2. Field Classification Taxonomy

1. **PUBLIC**: Product names, boutique public details, store address, catalog prices.
2. **INTERNAL**: Stock levels, warehouse location IDs, register numbers, internal SKUs.
3. **PERSONAL**: Customer names, phone numbers, delivery addresses, order quantities.
4. **SENSITIVE**: Customer credit balance (الكريدي), employee salary/shift notes, home addresses.
5. **HIGH_RISK**: Password hashes, session tokens, combined customer financial and contact histories.
6. **SECRET**: Encryption master keys, API key raw secrets, courier API keys, webhook signing secrets.
