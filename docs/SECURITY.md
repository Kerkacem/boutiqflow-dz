# BoutiqFlow DZ — Security, Authorization & Regulatory Compliance

**Standard:** OWASP ASVS Level 2 Oriented  
**Multi-Tenancy Isolation:** Dual-Layer (Application Scope + PostgreSQL `FORCE ROW LEVEL SECURITY`)  
**Regulatory Framework:** Algerian Data Protection Law 18-07 (Amended by Law 25-11, July 24, 2025)

---

## 1. Threat Model & Security Posture
BoutiqFlow DZ operates as a multi-tenant SaaS serving Algerian clothing stores. The primary threats addressed in our security architecture are:
1. **Cross-Tenant Data Leakage (IDOR):** An attacker from Boutique A attempts to access products, customer records, sales numbers, or inventory of Boutique B.
2. **Privilege Escalation & Financial Espionage:** Store employees (cashiers/stock assistants) attempting to discover wholesale cost prices, profit margins, or alter historical sales records.
3. **Double-Spend & Stock Corruption:** Race conditions caused by simultaneous in-store POS checkouts and online order confirmations.
4. **Webhook Forgery & Payment Tampering:** Attackers sending fabricated payment confirmation webhooks or replaying previously captured requests.
5. **Unauthorized Personal Data Exposure:** Violating Algerian privacy regulations by exposing customer names, phone numbers, and addresses.

---

## 2. Authentication & Session Security

### 2.1 Password Hashing & Salt Management
- Passwords are never stored in plain text.
- Standard: Salted PBKDF2-SHA512 with 100,000 iterations (or Argon2id in high-resource production environments).
- Cryptographically secure 32-byte salt generated per user via `crypto.randomBytes(32)`.
- Constant-time verification prevents timing attacks.

### 2.2 Session Tokens & Cookie Security
- Session IDs are 256-bit cryptographically secure pseudorandom tokens.
- Session tokens are stored hashed (`SHA-256`) in the database; a database breach does not expose active session tokens.
- Cookies configured with:
  - `HttpOnly: true` (immune to JavaScript XSS theft).
  - `Secure: true` (only transmitted over encrypted HTTPS).
  - `SameSite: Strict` (immune to Cross-Site Request Forgery).

### 2.3 Brute-Force Rate Limiting
- Failed authentication attempts trigger exponential backoff.
- Maximum 5 failed attempts per IP/Email within 15 minutes before temporary account lock.

---

## 3. Role-Based Access Control (RBAC) Matrix

| Resource / Action | CASHIER | STOCK_MANAGER | ACCOUNTANT | MANAGER | OWNER |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **POS Checkout & Scanning** | ✅ | ❌ | ❌ | ✅ | ✅ |
| **View Selling Prices** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **View Cost Prices / WAC** | ❌ (Denied) | ❌ (Denied) | ✅ | ✅ | ✅ |
| **View Gross / Net Profit** | ❌ (Denied) | ❌ (Denied) | ✅ | ✅ | ✅ |
| **Cash Drawer Open / Close**| ✅ | ❌ | ❌ | ✅ | ✅ |
| **Cash In / Cash Out** | With Mgr | ❌ | ❌ | ✅ | ✅ |
| **Supplier Receiving** | ❌ | ✅ | ❌ | ✅ | ✅ |
| **Physical Stocktake Count**| ❌ | ✅ | ❌ | ✅ | ✅ |
| **Stock Discrepancy Approval**| ❌ | ❌ | ❌ | ✅ | ✅ |
| **Expense Recording** | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Customer Debt Entry** | ✅ | ❌ | ✅ | ✅ | ✅ |
| **User Role Management** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Subscription & Billing** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Tenant Data Export/Delete**| ❌ | ❌ | ❌ | ❌ | ✅ |

*Rule:* Cashiers are strictly barred from seeing cost prices, supplier wholesale invoices, or store profit margins.

---

## 4. Multi-Tenant Row Level Security (RLS)
Dual-layer isolation ensures that even a catastrophic application-level bug cannot leak data across tenants:

1. **Layer 1: Application Transaction Wrapper:**
   Every query executes inside `withTenant({ tenantId }, async (tx) => { ... })`.
2. **Layer 2: PostgreSQL Engine-Enforced RLS:**
   Every tenant-scoped table has `FORCE ROW LEVEL SECURITY` enabled.
   ```sql
   ALTER TABLE products ENABLE ROW LEVEL SECURITY;
   ALTER TABLE products FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation_policy ON products
     FOR ALL
     USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
   ```

---

## 5. Webhook Security & Idempotency
All external integrations (Chargily Pay V2, Shopify, WooCommerce) adhere to strict security protocols:
1. **HMAC-SHA256 Signature Verification:** Webhook payloads are hashed with the shared tenant secret and compared using `crypto.timingSafeEqual` after verifying buffer length parity.
2. **Replay Protection:** Webhook timestamp headers are validated against a 5-minute maximum drift window.
3. **Idempotency Key Ledger:** Every processed webhook event ID is recorded in `webhook_events`. Duplicates are acknowledged with HTTP 200 without re-executing orders or stock movements.

---

## 6. Algerian Privacy Law Compliance (Law 18-07 & Law 25-11)
Algerian Law 18-07 on the Protection of Personal Data, updated and amended by Law 25-11 on July 24, 2025, governs the handling of customer and employee data:

1. **Data Minimization:** BoutiqFlow DZ collects only the strictly necessary fields required for retail fulfillment (Customer name, normalized Algerian phone number, delivery Wilaya/commune, shipping address).
2. **Zero Third-Party Aggregation:** Customer and store data is never sent to third-party ad networks or external analytics trackers.
3. **Data Portability:** Tenants can export their complete store database (JSON/CSV) at any time from the settings console.
4. **Right to Erasure & Retention:** When a tenant requests account deletion, a 30-day soft-deletion grace window is applied before permanent cryptographic purge.
5. **Regulatory Disclaimer:** *The technical safeguards implemented within BoutiqFlow DZ are designed to adhere to standard cybersecurity best practices and Law 18-07/25-11 privacy requirements. However, formal legal compliance requires validation by qualified Algerian legal counsel.*
