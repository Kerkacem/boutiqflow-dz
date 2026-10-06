# MAHAL — Production Release Readiness Checklist

This document records the formal verification sign-off across all engineering, security, operational, and business gates.

## 1. Quality & Test Gates
- [x] `pnpm verify` passes with 0 failures, 0 skipped tests (81 passing tests across 14 suites).
- [x] GitHub Actions CI workflow configured (`.github/workflows/ci.yml`) with PostgreSQL 15 service container.
- [x] All 18 UAT acceptance scenarios pass with logged evidence in `docs/VERIFY.md`:
  - [x] UAT-1: Tenant Onboarding & 200 Products Matrix
  - [x] UAT-2: Purchasing & Weighted Average Costing (WAC)
  - [x] UAT-3: POS Split Tender (Cash + Customer Credit "كريدي")
  - [x] UAT-4: POS Offline Queue & Idempotent Sync
  - [x] UAT-5: Concurrency Race Condition for Last Unit
  - [x] UAT-6: Online Order Lifecycle & COD Remittance Reconciliation
  - [x] UAT-7: Customer Return & Restocking
  - [x] UAT-8: Direct Size Exchange in One Flow (0 DA net)
  - [x] UAT-9: Physical Stocktake of 30 Variants with Variances
  - [x] UAT-10: End-of-Day Register Close & Z-Report
  - [x] UAT-11: Monthly P&L Reconciliation to the Centime
  - [x] UAT-12: RBAC Server-Side Enforcement (Masked Cost/Profit)
  - [x] UAT-13: Cross-Tenant Isolation Attack (404/403 on all routes)
  - [x] UAT-14: Subscription Lifecycle, BaridiMob & Chargily Webhooks
  - [x] UAT-15: Disaster Recovery (AES-256-GCM Backup, Wipe, Restore, INV-1 check)
  - [x] UAT-16: Full Tenant Export & 30-Day Soft Deletion
  - [x] UAT-17: Localization: Arabic RTL Default & French Switch
  - [x] UAT-18: Duplicate Order & Risky Customer Fraud Detection
- [x] Invariant property tests (INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7) pass.
- [x] Mutation testing verified: deliberately breaking RLS causes test suite failure.

## 2. Security & Compliance Gates
- [x] OWASP ASVS Level 2 verified:
  - [x] Dual-layer multi-tenancy: `withTenant()` and PostgreSQL `FORCE ROW LEVEL SECURITY`.
  - [x] Composite foreign keys `(tenant_id, id)`.
  - [x] Password hashing with salted PBKDF2 (100,000 iterations).
  - [x] Rate limiting with exponential backoff on repeated failed logins.
  - [x] Session tokens hashed at rest using SHA-256.
  - [x] Chargily webhook HMAC-SHA256 signature verification and replay protection.
  - [x] Zero leaked secrets in git repository (`scripts/security-scan.sh`).
  - [x] Data privacy (Algerian Law 18-07): Zero customer PII shared with aggregator tools.

## 3. Reliability & Operational Gates
- [x] Disaster recovery drill (UAT-15): Database serialized, encrypted with AES-256-GCM, wiped, restored, and data integrity verified.
- [x] Production deployment artifacts generated:
  - [x] `Dockerfile` (Multi-stage, minimal, non-root user `mahalapp:1001`).
  - [x] `docker-compose.yml` (App, PostgreSQL 15 Alpine with healthchecks, Caddy reverse proxy).
  - [x] `Caddyfile` (Automated Let's Encrypt TLS, HSTS, frame-ancestors none, strict CSP).
  - [x] `.env.example` template with security guidelines.
- [x] Healthcheck probes operational (`/api/health`, `/api/ready`).
- [x] Performance benchmark verified: 5,000 variants import processed in < 60ms (target was < 60s).

## 4. Human Sign-Off Gate
- [x] Phase P1 Human Checkpoint: Delivered & Approved.
- [x] Phase P4 Human Checkpoint: Delivered & Approved.
- [x] Phase P5 Human Checkpoint: Delivered & Approved.
- [x] **Final Production "GO PROD" Gate:** Approved by Belkacem on 2026-10-06 ("Go prod").
- **Release Status:** **PRODUCTION DEPLOYMENT AUTHORIZED & EXECUTED (v1.0.0)**.
