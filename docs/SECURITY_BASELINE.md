# BoutiqFlow DZ — Comprehensive Security Baseline & Threat Model (Phase 13)

## 1. Executive Summary & Purpose
This document defines the formal security baseline, architectural threat model, and verification criteria for **BoutiqFlow DZ**, an omnichannel, multi-tenant retail SaaS platform tailored for Algerian physical boutiques, COD operations, and social commerce.

In accordance with Phase 13 requirements, BoutiqFlow rejects the assumption that functional tests alone guarantee security. Security is established through continuous automated verification, red-team attack resilience, defense-in-depth isolation, and data integrity verification under destructive chaos.

---

## 2. Standards Alignment

### 2.1 OWASP Top 10:2025 Taxonomy & Coverage Matrix
The system's technical controls are directly mapped to the **OWASP Top 10:2025** categories:

| Category | Name | Technical Controls in BoutiqFlow DZ |
|---|---|---|
| **A01** | **Broken Access Control** | Row-Level Security (RLS) forced per tenant; role-based access control (RBAC) enforced strictly server-side (`OWNER`, `MANAGER`, `CASHIER`, `STOCK_MANAGER`, `ONLINE_MANAGER`, `ACCOUNTANT`, `SUPER_ADMIN`, `DPO`); zero client-driven privilege escalation (`PLAN_FORGED`, IDOR defenses). |
| **A02** | **Security Misconfiguration** | `DEBUG=false` in production; stack traces hidden from API responses; strict security headers (HSTS, CSP, X-Content-Type-Options, Referrer-Policy, Permissions-Policy); no wildcard CORS with credentials. |
| **A03** | **Software Supply Chain Failures** | Immutable lockfile enforcement (`package-lock.json`); automated dependency vulnerability scans; Software Bill of Materials (SBOM); rejection of known exploitable dependencies in CI. |
| **A04** | **Cryptographic Failures** | Separation of encryption keys (KEK/DEK envelope encryption); Argon2id / PBKDF2 with unique salts for passwords; AES-256-GCM with unique, random 96-bit nonces per encryption; zero raw card data (PAN/CVV) storage. |
| **A05** | **Injection** | Parameterized queries on all database operations; strict sanitization of search and filter terms; CSV formula injection defense (prefixing `=`, `+`, `-`, `@`); JSON prototype pollution guards. |
| **A06** | **Insecure Design** | Architectural boundary enforcement (e.g. inventory ledger cannot be mutated directly; invoices are immutable once issued); state machines prevent illegal status reversals. |
| **A07** | **Authentication Failures** | Scoped sliding-window rate limiting; progressive backoff on failed logins; secure session token hashing at rest with constant-time verification; session revocation on password change. |
| **A08** | **Software and Data Integrity Failures** | Cryptographically chained audit logs and Automated Processing Journals (SHA-256 hash chains); incoming webhook HMAC-SHA256 signature verification; payload hash deduplication. |
| **A09** | **Security Logging and Alerting Failures** | Structured audit logging with correlation IDs; real-time alert generation for failed logins, IDOR attempts, journal tampering, and rate-limit spikes; strict PII and secret redaction. |
| **A10** | **Mishandling of Exceptional Conditions** | Fail-closed defaults on authorization and transfer guards; bounded retries with exponential backoff; dead-letter queues for unprocessable events; graceful degradation during provider outages. |

### 2.2 OWASP ASVS Target Level 3 Alignment
BoutiqFlow DZ targets **OWASP Application Security Verification Standard (ASVS) Level 3** for critical financial and multi-tenant isolation components:
- V1: Architecture, Design and Threat Modeling
- V2: Authentication Verification
- V3: Session Management
- V4: Access Control
- V5: Validation, Sanitization and Encoding
- V6: Stored Cryptography
- V7: Error Handling and Logging
- V8: Data Protection & Privacy (Algerian Law 18-07 / 25-11)
- V9: Communications
- V10: Malicious Code
- V11: Business Logic
- V12: File and Resource Handling
- V13: API and Web Service
- V14: Configuration

### 2.3 NIST SP 800-61 Rev. 3 & Data Integrity Recovery
Following **NIST SP 800-61 Rev. 3** (Incident Response Recommendations and Coordinating Computer Security Incidents) and NIST guidelines on recovering from destructive events (ransomware, data corruption):
- **Identification & Scope**: Fast anomaly detection via continuous data integrity checks (`IntegrityCheckJob`).
- **Containment**: Read-only degradation or automated tenant suspension without data loss.
- **Eradication**: Secure session revocation, API key disabling, and subprocessor cut-off.
- **Recovery**: Verified restore from encrypted, immutable backup snapshots with pre-reopening integrity validation.
- **Post-Incident Review**: Mandatory root-cause analysis and control updates.

---

## 3. Threat Model & Security Boundaries

```
[ External World ] ──► ( TLS 1.3 / Reverse Proxy / WAF )
                                    │
                       [ Rate Limiting & SSRF Filter ]
                                    │
                       [ Auth & Session Validation ]
                                    │
             [ Multi-Tenant Context Injection (RLS Session) ]
                                    │
                 ┌──────────────────┴──────────────────┐
                 ▼                                     ▼
     [ Core Business Services ]             [ Commercial Billing & Entitlements ]
     (Inventory, POS, COD, Logistics)       (Subscriptions, Invoices, Payments)
                 │                                     │
                 └──────────────────┬──────────────────┘
                                    ▼
                       [ Authoritative Data Layer ]
            (PostgreSQL with FORCE RLS + Immutability Guards)
```

### 3.1 Trust Assumptions & Non-Assumptions
1. **Clients are Untrusted**: No client-provided plan, price, cost, role, or tenant identifier is ever trusted.
2. **External Providers are Untrusted**: Couriers, marketplaces, and payment gateways can fail, send duplicate webhooks, or experience timeouts. Local committed state is never rolled back due to remote provider failure.
3. **Database Connections are Reused**: Connection pools must never carry residual session variables, prepared statements, or uncommitted transactions across tenant boundaries.

---

## 4. Security Verification Gates
To achieve **GATE 13 = GREEN**, the automated test suite must demonstrate:
1. Zero known exploitable critical supply chain vulnerabilities.
2. Zero secrets in source code, commit history, configuration, or logs.
3. Zero cross-tenant data leaks or mutations under fuzzing and concurrency.
4. Total resilience against injection (SQL, CSV, SSRF, XSS).
5. 100% deterministic data recovery from synthetic corruption and disaster scenarios.
