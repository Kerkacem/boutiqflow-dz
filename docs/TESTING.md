# BoutiqFlow DZ — Testing Strategy & Verification Protocol

**Verification Philosophy:** A feature is NOT done because "the code compiles" or "the page renders". A feature is ONLY done when validated against executed automated tests, boundary attacks, and logged evidence.

---

## 1. The 12 Mandatory Business Invariants

| Invariant | Description | Verification Method |
| :--- | :--- | :--- |
| **INV-1** | A sale cannot be committed twice. | Idempotency key uniqueness check (`tests/invariants.test.js`, `tests/pos_p4.test.js`) |
| **INV-2** | A webhook cannot create the same order twice. | Idempotent event ledger check (`tests/saas_p7.test.js`, `tests/connectors.test.js`) |
| **INV-3** | A sale cannot reduce stock twice. | Single authoritative `StockMovement` ledger transaction (`tests/inventory_p3.test.js`) |
| **INV-4** | Available stock cannot exceed on-hand ($Available \le OnHand$). | Database column generation constraint & domain check (`tests/inventory_p3.test.js`) |
| **INV-5** | Reserved stock cannot become inconsistent ($Reserved \ge 0$). | Atomic reservation state machine (`tests/inventory_p3.test.js`, `tests/orders_p5.test.js`) |
| **INV-6** | A cashier cannot view or alter protected financial fields. | Strict RBAC permission matrix checks (`tests/rbac_matrix.test.js`) |
| **INV-7** | Tenant A cannot read or mutate Tenant B records. | Cross-tenant RLS penetration attack suite (`tests/tenant_isolation.test.js`, `tests/security_attack_p8.test.js`) |
| **INV-8** | A cancelled online order releases its reservation exactly once. | Order cancellation lifecycle verification (`tests/orders_p5.test.js`) |
| **INV-9** | A return increases stock only if resalable. | Resalable vs damaged condition branching (`tests/orders_p5.test.js`, `tests/pos_p4.test.js`) |
| **INV-10**| Cash closing accurately computes expected cash and variance. | Register shift Z-report calculation (`tests/pos_p4.test.js`) |
| **INV-11**| Offline retry cannot duplicate financial transactions. | Client outbox sequence + server idempotency (`tests/pos_p4.test.js`) |
| **INV-12**| Concurrent sales cannot corrupt stock (race condition). | Concurrency race condition simulation (`tests/pos_p4.test.js`) |

---

## 2. Specialized Stress & Chaos Test Suites

### 2.1 Concurrency Race Condition Test (`UAT-5`)
- **Setup:** A single unit of clothing variant `TS-RACE-001` remains in stock ($OnHand = 1, Available = 1$).
- **Action:** A physical store cashier at the POS and an online customer on the web store attempt to purchase that exact last unit simultaneously.
- **Result:** Exactly one transaction acquires the inventory lock and succeeds. The second transaction is rejected with an out-of-stock notification. The resulting stock is $0$, never $-1$.

### 2.2 Offline PWA Chaos Test (`UAT-4`)
- **Setup:** Internet connectivity is severed. The POS registers 5 offline sales, storing transactions in IndexedDB outbox with sequential receipt IDs (`R1-000101` to `R1-000105`).
- **Chaos Injection:** Simulated browser refresh, network timeout, and duplicate transmission of the same outbox batch.
- **Result:** Exactly 5 sales records, 5 payment records, and 5 stock movements created on the server. Zero duplicate deductions or phantom receipts.

### 2.3 Bulk CSV Import Chaos Test (`UAT-1`)
- **Setup:** A corrupted CSV file containing 2,000 rows with missing prices, duplicate SKUs, invalid sizes, and mixed Arabic/French text.
- **Result:** Pre-import validation engine parses and highlights the exact row and column errors. The atomic transaction triggers a clean rollback: exactly 0 rows are committed to the database.

---

## 3. Test Suite Structure & Verification Command

All verification tests are executed via `scripts/verify.sh`:
```bash
bash scripts/verify.sh
```

### Breakdown of Test Suites (88 Passing Tests):
1. `tests/invariants.test.js`: Strict BigInt centimes math, Algerian phone normalization (`+213`), UUIDv7 specification, idempotency key uniqueness.
2. `tests/tenant_isolation.test.js`: RLS table query, direct lookup, mutation leak tests.
3. `tests/with_tenant.test.js`: Missing context failure, rollback on exception, concurrent tenant isolation.
4. `tests/rbac_matrix.test.js`: Cashier, Stock Clerk, Accountant, Manager, and Owner permission boundaries.
5. `tests/auth_security.test.js`: Salted PBKDF2 password hashing, brute-force rate-limiting, hashed session tokens.
6. `tests/audit_log.test.js`: Append-only audit record creation and tenant isolation.
7. `tests/i18n.test.js`: Arabic RTL directionality, French LTR, translation key parity.
8. `tests/catalog_p2.test.js`: EAN-13 barcodes, clothing size/color Cartesian matrix, CSV validation and rollback.
9. `tests/inventory_p3.test.js`: Central inventory ledger, multi-location transfer, WAC costing, physical stocktake reconciliation.
10. `tests/pos_p4.test.js`: POS checkout, split tenders, in-store size exchange, offline outbox, Z-report cash closing.
11. `tests/orders_p5.test.js`: Online orders Kanban, Yalidine/Ecotrack/ZR courier adapters, COD remittance, duplicate order detection.
12. `tests/finance_p6.test.js`: Categorized expenses, true P&L reconciliation to the centime, dead stock detector, size curves.
13. `tests/saas_p7.test.js`: Subscriptions state machine, manual BaridiMob workflow, Chargily Pay V2 webhooks, tenant data export.
14. `tests/security_attack_p8.test.js`: Scripted pentest (IDOR, mass assignment, privilege escalation), backup/restore drill.
15. `tests/connectors.test.js`: Shopify & WooCommerce connectors, SKU-first mapping, unmapped items triage, central inventory sync.
