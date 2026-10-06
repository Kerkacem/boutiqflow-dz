# BoutiqFlow DZ — Phase 12: SaaS Plans + Trial + Billing + Tenant Lifecycle + Abuse Prevention

## 1. Objective
Establish an independent, robust, and commercial SaaS subscription and billing domain for BoutiqFlow DZ. Transform BoutiqFlow into a commercially sellable multi-tenant retail SaaS while ensuring billing never serves as a backdoor to compromise security, escalate privileges, or delete operational data.

Core Architectural Golden Rule:
```
Billing State ──► Entitlement Engine ──► Feature Access ──► Application
```
Never:
```
Frontend claims plan = PRO ──► Application trusts it (REJECTED: PLAN_FORGED)
```

## 2. Invariants & Guardrails
- Reference `PROJECT.md` (`INV-12-01` to `INV-12-30`) for permanent commercial subsystem invariants.
- **Authoritative Subscription Boundary (`INV-12-01`, `INV-12-02`):** Client and frontend state never define plans or subscriptions. Feature entitlement is evaluated server-side via `EntitlementEngine`.
- **Plan Version Price Immutability (`INV-12-03`):** Commercial pricing changes create new versions in `plan_versions`; historical invoices permanently retain original pricing snapshots.
- **Issued Invoice Immutability (`INV-12-04`, `INV-12-05`):** Invoices cannot be modified after issuance. Corrections are performed via Credit Notes, Debit Notes, or formal voiding.
- **Webhook Deduplication & Amount Integrity (`INV-12-06`, `INV-12-07`, `INV-12-28`):** Inbound payment webhooks are deduplicated against `billing_provider_events`. Incoming amounts and currencies are strictly verified against expected invoice state; mismatches trigger `PAYMENT_MISMATCH` and deny activation.
- **Idempotency Conflict Rejection (`INV-12-08`):** Same idempotency key with different payload is rejected with a 409 conflict (`IDEMPOTENCY_PAYLOAD_MISMATCH`).
- **Subscription State Machine (`INV-12-09`):** Transitions follow strict rules (`TRIALING`, `ACTIVE`, `PAST_DUE`, `GRACE_PERIOD`, `READ_ONLY`, `SUSPENDED`, `CANCELLED`, `EXPIRED`). Reactivation from `SUSPENDED` strictly requires validated payment.
- **Idempotent Provisioning (`INV-12-10`, `INV-12-11`):** Signup retries and trial onboarding are completely replay-safe without creating duplicate tenants, users, or subscriptions.
- **Privacy-Aware Abuse Prevention (`INV-12-12`, `INV-12-13`):** Phone verification OTP rate limiting, cooldowns, and attempt caps without excessive fingerprinting. Isolated signals trigger step-up challenges rather than automated bans.
- **Mutation Guard on Suspended/Read-Only Tenants (`INV-12-14`):** Suspended tenants cannot perform operational mutations. Read-only tenants can view reports and export allowed data, but mutations are blocked.
- **Operational Data Preservation (`INV-12-15`, `INV-12-16`):** Billing suspension and plan downgrades never delete inventory, sales, customers, or users. Downgrades with excess usage flag `LIMIT_VIOLATION`.
- **Deletion Blockers & Legal Hold (`INV-12-17`):** Active Legal Holds, open personal data breaches, or billing disputes strictly block tenant deletion.
- **Documented Admin Overrides (`INV-12-18`):** Comp access and administrative grants require documented reason, approver, ticket reference, time-bounded expiration, and audit logging.
- **Payment Data Security (`INV-12-19`, `INV-12-20`):** Zero raw card data (PAN, CVV) enters or persists in databases. Provider credentials are encrypted at rest.
- **Billing Reconciliation (`INV-12-21`):** Daily reconciliation compares provider payment streams with internal invoices to recover lost webhooks and detect discrepancies.
- **Entitlement Cache Invalidation (`INV-12-22`):** In-memory entitlement caches have short TTL and are immediately invalidated on subscription status change, plan change, or admin override.

## 3. Subsystem Modules & Directory Structure
- `src/billing/constants.js`: Commercial plans, features, limits, statuses, abuse signals, decisions, and error codes.
- `src/billing/plan_service.js`: Versioned plan snapshot lookup, creation, and price stability.
- `src/billing/entitlement_engine.js`: Authoritative server-side feature access, hard/soft limit checks, forged plan rejection, short-lived cache with immediate invalidation.
- `src/billing/subscription_service.js`: Subscription state machine, upgrade/downgrade without user deletion, mutation guard (`assertMutationAllowed`), and deterministic proration calculator.
- `src/billing/invoice_service.js`: Monotonic numbering (`BF-2026-000001`), issued invoices, credit note reversals, formal voiding.
- `src/billing/payment_service.js`: Webhook deduplication (`billing_provider_events`), expected invoice amount/currency verification (`PAYMENT_MISMATCH`), idempotency keys, and subscription activation.
- `src/billing/billing_reconciliation.js`: Reconciles provider payments, detects missing/duplicate payments, recovers lost webhooks.
- `src/billing/tenant_lifecycle_service.js`: Lifecycle transitions, read-only/suspension mutation blocker, deletion blockers (`LEGAL_HOLD_ACTIVE`).
- `src/billing/provisioning_service.js`: Idempotent tenant provisioning and 14-day trial onboarding.
- `src/billing/phone_verification_service.js`: OTP generation, hashing, rate limits, resend cooldown, and attempt limits.
- `src/billing/abuse_service.js`: Sliding-window rate limiting, privacy-aware risk signal evaluation (`ALLOW`, `CHALLENGE`, `LIMIT`, `REVIEW`, `BLOCK`).
- `src/billing/admin_override_service.js`: Comp grants and administrative entitlement overrides with mandatory audit evidence.
- `src/billing/usage_metering.js`: Ingestion of idempotent canonical usage events and rebuildable materialized aggregates.
- `src/billing/index.js`: Unified exports for commercial billing subsystem.

## 4. Verification Evidence
14 dedicated test suites verifying all Phase 12 requirements and invariants:
- `tests/phase12_plan_entitlement.test.js`
- `tests/phase12_trial_abuse.test.js`
- `tests/phase12_subscription_state.test.js`
- `tests/phase12_invoice_immutability.test.js`
- `tests/phase12_payment_idempotency.test.js`
- `tests/phase12_payment_webhook.test.js`
- `tests/phase12_billing_reconciliation.test.js`
- `tests/phase12_tenant_lifecycle.test.js`
- `tests/phase12_deletion_guard.test.js`
- `tests/phase12_usage_limits.test.js`
- `tests/phase12_entitlement_cache.test.js`
- `tests/phase12_abuse_rate_limits.test.js`
- `tests/phase12_admin_override.test.js`
- `tests/phase12_tenant_provisioning.test.js`

Status: **GATE 12 = GREEN**
All 112 suites (559 tests) passing cleanly with 100% regression stability.
