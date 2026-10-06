# MAHAL — Risk Matrix & Mitigation Strategies

| Risk Category | Specific Risk | Severity | Mitigation Strategy |
|---|---|---|---|
| **Market / Adoption** | Retailers refuse subscription after 14-day trial | High | Pre-launch validation (Week 0 outreach), free white-glove catalog onboarding, local BaridiMob payment options. |
| **Integrations** | Courier APIs (Yalidine, ZR, Ecotrack) change unannounced | High | Strict modular adapter interfaces, contract tests with recorded network fixtures, official vendor docs fetched at build. |
| **Connectivity** | Intermittent 4G / ADSL retail boutique connectivity | High | PWA offline outbox (IndexedDB), client sequence generators, server idempotency keys. |
| **Fiscal / Legal** | Changes in Algerian tax rates or audit regulations | Medium | Configurable tenant tax profiles (VAT rates, stamp duties); clear disclaimer that MAHAL is a management suite, not certified accounting software. |
| **Data Privacy** | Compliance with Algerian Law 18-07 on personal data | Medium | Data minimization, encrypted courier credentials (AES-256-GCM), full self-service tenant export and deletion. |
| **Data Integrity** | Concurrency race condition selling last variant | High | Row-level locking on inventory balances within atomic PostgreSQL transactions (`INV-7`). |
| **Financial Security** | Forged or replayed Chargily Pay webhooks | Critical | HMAC-SHA256 signature verification, API status re-fetch, idempotent webhook event logging. |
