# BoutiqFlow DZ — Phase 01: Auth, Multi-Tenancy, RBAC, Tenant Isolation

## 1. Objective
Implement secure authentication, session management, and dual-layer multi-tenancy with strict RBAC.

## 2. Invariants & Guardrails
- Reference `PROJECT.md` for permanent engineering invariants.
- Strict adherence to Principle #0: Personal data protection under Algerian Law 18-07 / 25-11.
- No direct stock mutations outside `InventoryDomainService`.
- No floating-point arithmetic for currency.

## 3. Concrete Milestones & Tasks
- [x] Implement withTenant() transaction wrapper with SET LOCAL app.tenant_id
- [x] Enforce FORCE ROW LEVEL SECURITY across all tenant tables
- [x] Implement salted PBKDF2/Argon2id password hashing and session tokens
- [x] Implement session rotation upon login and token hashing at rest (SHA-256)
- [x] Enforce RBAC matrix covering OWNER, MANAGER, CASHIER, STOCK_MANAGER, ONLINE_MANAGER, ACCOUNTANT
- [x] Enforce explicit permission denials: Cashier denied cost prices, profit margins, voids, price changes, and role editing
- [x] Implement append-only business audit logging with security actions (LOGIN, LOGOUT, ROLE_CHANGE, SUSPICIOUS_CROSS_TENANT_ATTEMPT)
- [x] Enforce privacy boundary: Super Admin denied automatic customer PII access; emergency access requires mandatory justification and audit trail
- [x] Implement and pass hostile cross-tenant penetration attack suite (tests/phase01_security_hostile.test.js)

## 4. Verification & Exit Criteria
- Tests pass: tests/tenant_isolation.test.js, tests/with_tenant.test.js, tests/rbac_matrix.test.js, tests/auth_security.test.js, tests/audit_log.test.js, tests/phase01_security_hostile.test.js.
- Automated test command: `bash scripts/verify.sh`
- Once all tests pass and evidence is logged in `docs/VERIFY.md`, update `docs/BUILD_STATUS.md` and proceed to Phase 02.
- **GATE 01 STATUS: GREEN**
