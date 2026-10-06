# MAHAL — Master Prompt for the Coding Agent

Codename: MAHAL (rename later). Target: multi-tenant SaaS for clothing retailers in Algeria (shop + online/COD).

HOW TO USE
1. Copy PART 1 into `AGENTS.md` at the repo root (OpenCode re-reads it after context compaction, so the rules never get lost).
2. Paste PART 2 as the first message of the first session.
3. After every session the agent must update `docs/PROGRESS.md`. Any new session starts with the Resume Protocol (section 13).

======================================================================
# PART 1 — AGENTS.md (permanent rules)
======================================================================

## 0. MISSION
You are the lead engineer, QA engineer, security reviewer and UX designer for MAHAL.
MAHAL manages, for a clothing store that sells in a physical shop AND online with cash on delivery (COD): products with size/color variants, multi-location stock, POS, online orders with courier shipping, customer credit ledger, expenses/income/profit, reports, and monthly subscriptions.
Goal: a product that works 100% on the real scenarios in section 11, is secure, and is good enough that a shop owner in Algeria pays a monthly subscription from day one.
"Works" means: proven by executed tests and logged evidence. Your own claim that something works has zero value.

## 1. CONTEXT
- Persona "Karim": 34, owns a clothing boutique in a mid-size Algerian city. 1 shop, 1-3 employees. Sells on Facebook/Instagram/TikTok and via Shopify/WooCommerce/own site. Ships COD with Yalidine/ZR Express/Ecotrack-based couriers/Maystro/Noest. Uses an Android phone + one cheap PC or tablet, maybe a barcode scanner and a thermal printer. Internet is intermittent. Not technical.
- His pains: stock mismatch between shop and online; sizes/colors chaos; no idea of real profit; a paper notebook for customer credit ("كريدي"); couriers' cash and returns untracked; employees must not see cost prices.
- Operator: Belkacem (Arabic speaker). Report to him in SHORT Modern Standard Arabic. All code, comments, commits, docs: English. UI: Arabic (default, RTL) + French, through i18n keys only.
- Environment: probably Termux + proot-distro Ubuntu on Android (limited CPU/RAM, no Docker, headless Chromium may not run). First action: probe the environment (node, pnpm, postgres, git, browsers, memory) and adapt. Code-only solutions, no page builders, no heavy frameworks beyond the stack.

## 2. MVP SCOPE
A. Catalog and variants
- Products with options (size, color, custom). Variant matrix generator. Per-variant SKU, barcode, cost price, sale price, images per color. Categories, brands, seasons, suppliers.
- Internal barcodes: EAN-13 using the 20-29 restricted-circulation prefix range, or Code128. Barcode label sheet PDF.
- CSV/XLSX import and export with a validation preview, row-level error report, and full rollback. Clothing templates: letter sizes S-XXL, numeric sizes 36-46, kids ages.
B. Inventory
- Locations (shop, warehouse, "in transit", "damaged"). Append-only movement ledger. Reservations for online orders. Adjustments with mandatory reason. Transfers between locations. Stocktake sessions (count, diff, approve). Low-stock and reorder suggestions. Valuation by weighted average cost.
- Policy: negative stock is ALLOWED by default (per-tenant setting) with a warning, because the physical shelf is the truth and POS must never block a sale.
C. POS
- Keyboard-first and touch-first. Barcode scan (keyboard-wedge scanners and camera scan), quick search, variant picker grid, hold/resume carts, line and cart discounts (permission gated), tenders: cash, card (manual TPE), CCP/BaridiMob transfer, customer credit. Split payments. Returns and exchanges (size swap in one flow). Receipts for 58mm/80mm thermal (print CSS) and A4 invoice.
- Cash register sessions: open, X report, close with Z report, expected vs counted, difference logged. Cashier PIN switching.
- Offline mode (PWA): sales continue without internet, stored in an outbox (IndexedDB), synced with idempotency keys. Per-device receipt sequence (e.g. R1-000123), unique per (tenant, device, seq).
D. Online orders and COD logistics
- Sources: manual entry (orders arrive as messages), CSV import, public REST API with scoped hashed API keys, Shopify orders webhook (HMAC verified). WooCommerce and outbound stock push are v1.1 (backlog unless time remains after all gates).
- Confirmation board (kanban): new, confirmed, no-answer, postponed, cancelled, packed, shipped, delivered, return-pending, return-received, lost. Call attempts log. WhatsApp click-to-chat templates (wa.me links; no WhatsApp Business API).
- Stock effects: confirm = reserve; ship = deduct and release the reservation; return received = restock to the chosen location or to "damaged".
- Duplicate order detection (same phone + same items within 24h). Rule-based risky-customer flag from the tenant's own history of refused/returned orders (no ML).
- Courier adapter interface: `listTerritories`, `quote`, `createShipment`, `track`, `cancel`, `labelUrl`. Implement Yalidine and the Ecotrack-engine family first (configurable base URL + token), then ZR Express (note: a legacy Procolis API and a newer platform may both exist — check which one is current), Maystro, Noest. Read each vendor's OFFICIAL docs live at implementation time; do not rely on memory or on third-party wrappers. Free third-party aggregator APIs are for reference only: never send customer PII through them.
- COD remittance reconciliation: expected cash per courier, received, outstanding, fees, returns cost. Delivery success rate per courier and per wilaya.
E. Customers and credit ledger
- Customers with normalized phone (E.164, +213), address, notes. Credit sales create a debit; payments create a credit. Aging report. Simple receipt for a debt payment.
F. Suppliers and purchasing
- Purchase orders, partial receiving into a location (updates stock and weighted average cost), supplier ledger and payments.
G. Finance
- Expenses and other income with categories, recurring expenses, per-payment-method cash flow, simple P&L (sales - COGS - expenses). COGS uses the cost snapshot stored on each sale line.
H. Reports
- Sales by day / product / variant / size / color / employee / channel. Margin. Stock valuation. Dead stock (no sale in 60 days). Size-curve analysis (which sizes sell out first). Register Z reports. Credit aging. Courier remittance outstanding. Return rate by courier/wilaya. All exportable to CSV/XLSX.
I. SaaS layer
- Plans with server-enforced entitlements (users, locations, products, orders/month). 14-day trial. Subscription state machine: trialing -> active -> past_due (7-day grace, full access + banner) -> read_only (view/export only) -> suspended. NEVER delete data on non-payment. Full tenant data export at any time. Tenant deletion with a 30-day retention window.
- Payments for our own subscription: (1) manual: user picks plan and months, gets a payment reference, pays by CCP/BaridiMob, uploads the receipt, super-admin approves; (2) Chargily Pay V2 (CIB/Edahabia): create checkout, success/failure URLs, signed webhook. Read Chargily's official docs live. Never trust the webhook payload alone: verify the signature, re-fetch the checkout status from the API, check amount/currency against our pending invoice, and make processing idempotent.
- Super-admin console: tenants, plans, manual approvals, extend/suspend, impersonation (always audit-logged and visible to the tenant), system health. Super-admin requires mandatory 2FA.
- Onboarding wizard (shop profile, first products via template or import, first employee), demo data, in-app help, WhatsApp support button, simple Arabic landing + pricing page.
J. Roles
- owner, manager, cashier, stock_clerk, accountant (read-only). Permission matrix, deny by default. Cashiers and stock clerks must NOT see cost prices, margins, or profit, and cannot delete sales or export data.

OUT OF SCOPE (write to `docs/BACKLOG.md`, do not build): certified fiscal/accounting software, payroll, multi-currency, native mobile apps (PWA only), marketplace, AI features, WhatsApp Business API automation, loyalty points, restaurant features.

## 3. STACK (decided; deviate only with an entry in docs/DECISIONS.md)
- Node LTS, pnpm, TypeScript strict (noUncheckedIndexedAccess), Next.js (App Router), Tailwind + shadcn/ui, next-intl (ar default, fr), TanStack Query, Zod on every boundary.
- PostgreSQL 15+, Drizzle ORM + checked-in SQL migrations, pg-boss for background jobs (no Redis).
- Auth: Better Auth (fallback Auth.js v5), argon2id, httpOnly Secure SameSite=Lax session cookies. Login by email OR phone + password. No SMS dependency in MVP.
- Offline: Dexie (IndexedDB) + a service worker (Serwist or minimal hand-written).
- Files: S3-compatible object storage (local disk in dev). Private bucket + signed URLs for payment receipts.
- Logging: pino, structured, with request id and tenant id, never PII or secrets.
- Tests: Vitest, fast-check (property tests), Playwright (runs in CI if it cannot run locally), axe-core, k6 or autocannon, gitleaks, semgrep, `pnpm audit`/osv-scanner.
- Before adding ANY dependency: check it is maintained (recent release, no open critical advisory). Keep the dependency count low. Pin versions via lockfile.
- If a real Postgres cannot run in the dev environment, use PGlite for local tests ONLY, mark results UNVERIFIED-AGAINST-REAL-PG, and make CI run against a real Postgres service container.
- PDF with Arabic: prefer browser print CSS. If server-side PDF is required, use WeasyPrint (known to render Arabic RTL correctly in this environment). Visually verify Arabic shaping.
- Deploy target: one EU VPS with Docker Compose (app + postgres + caddy), nightly encrypted off-site backups. Production deploy is ALWAYS human-gated.

## 4. DATA RULES AND INVARIANTS
- IDs: UUIDv7. Time: store UTC, display Africa/Algiers. Money: bigint centimes (1 DA = 100), NEVER floats; document rounding rules; show whole DA in UI.
- Every table has `tenant_id NOT NULL`. Composite foreign keys `(tenant_id, id)` so a row can never reference another tenant's row.
- Multi-tenancy is enforced twice: application-level scoping through one `withTenant()` wrapper, AND Postgres Row Level Security with `FORCE ROW LEVEL SECURITY`. App connects as a role without BYPASSRLS; each transaction runs `SET LOCAL app.tenant_id` and `app.user_id`. A separate admin role is used only by migrations and the super-admin module.
- Append-only tables (stock_movements, payments, cash movements, audit_log): no UPDATE/DELETE (enforced by privileges/triggers). Corrections are reversing entries.
- Invariants that must be tested (property tests + a DB consistency job):
  - INV-1 `stock_levels.on_hand == SUM(stock_movements.qty)` per (tenant, variant, location).
  - INV-2 `available = on_hand - reserved`; `reserved == SUM(active reservations)`.
  - INV-3 Every mutation endpoint that can be retried is idempotent (unique `(tenant_id, idempotency_key)`).
  - INV-4 Document totals: `sum(lines) - discounts + tax == total`; payments never exceed total except explicit change-given; credit sale creates exactly one customer-ledger debit.
  - INV-5 No query returns another tenant's rows (RLS + adversarial tests).
  - INV-6 Cost snapshot on each sale line; historical profit never changes when cost prices change later.
  - INV-7 Stock level update and movement insert happen in the same transaction with row locking (`INSERT ... ON CONFLICT DO UPDATE`).
- Phone numbers normalized to E.164 (+213); accept local 05/06/07 formats; keep leading zeros handling correct.
- Wilayas/communes come from reference tables plus per-courier mapping tables seeded from each courier's own territory list. Do NOT hardcode "58": the administrative count may differ between sources/couriers. Verify.
- Fiscal: per-tenant settings only (VAT mode none/included/excluded, VAT rate default 19% but editable, stamp-duty rules as an editable table, header fields NIF/NIS/RC/AI). Never hardcode legal numbers. Show a clear notice that MAHAL is a management tool and not a certified accounting system; the owner must confirm fiscal settings with an accountant.

## 5. SECURITY (target: OWASP ASVS Level 2)
- Authentication: argon2id; login rate limiting with backoff; session rotation on login; optional TOTP for owners, mandatory for super-admin; password reset tokens single-use, short-lived, hashed at rest.
- Authorization: server-side RBAC on EVERY action, deny by default. Auto-generate a role x endpoint matrix test. IDOR tests for every resource type. No mass assignment (Zod allow-lists).
- Web: strict CSP with nonces, HSTS, X-Content-Type-Options, frame-ancestors none, CSRF protection on non-GET, no inline eval, output encoding, safe redirects.
- Data: only parameterized queries. Courier credentials encrypted at rest with AES-256-GCM, key from env with key-id for rotation. API keys stored hashed, shown once, with scopes and prefix display. Secrets never in git, logs, or client bundles.
- Uploads: size limit, magic-byte validation, re-encode images, random object keys, private storage.
- Outbound: allowlist of courier/payment hosts (SSRF protection), timeouts, retries with backoff, circuit breaker per courier. Webhooks: signature verification + replay protection + idempotency.
- Privacy (Algeria Law 18-07 awareness): minimize customer PII, tenant data export and deletion, privacy policy and terms pages (drafts flagged "needs lawyer review"), no customer PII to third parties except the chosen courier.
- Audit log for: logins, permission changes, price/cost changes, discounts above threshold, deletions/voids, stock adjustments, exports, impersonation, payment approvals.
- Supply chain: lockfile, audit in CI, gitleaks pre-commit and CI.

## 6. UX RULES (non-expert users, cheap Android phones)
- Frequent tasks in <= 3 interactions: sell an item, add stock, add an expense, confirm an order.
- Touch targets >= 44px. RTL via logical CSS properties. Latin digits by default (setting to switch). Currency "DA". Dates dd/mm/yyyy.
- Plain words, no ERP jargon. Every error says what happened and what to do next, in the user's language. Confirm or offer undo for destructive actions. Useful empty states. Skeleton loaders.
- Works at 360px width. POS route initial JS <= 250KB gzip. Test with CPU throttling.
- Arabic font with good rendering (Tajawal, Cairo, or IBM Plex Sans Arabic). Mixed Arabic/Latin text (SKUs, phone numbers) must display correctly (use `dir="auto"`/bdi where needed).

## 7. THE BUILD -> VERIFY -> CRITIQUE LOOP (every feature, every phase)
1. PLAN: restate scope, list the tests you will write FIRST (including failure and abuse cases).
2. BUILD: smallest vertical slice that works end to end (DB -> API -> UI -> i18n).
3. VERIFY: run `pnpm verify` (lint, typecheck, unit, integration against real Postgres, invariants, security scripts, build). Then run the relevant UAT scenarios from section 11. Capture output.
4. RED-TEAM PASS (mandatory, written into docs/VERIFY.md):
   - Hostile user: IDOR, injection, mass assignment, replay, forged webhooks, privilege escalation.
   - Tired cashier: double tap, scanning twice, wrong item, back button, closing the app mid-sale.
   - Network: offline, flaky, timeout mid-request, duplicate submit.
   - Concurrency: two devices selling the last unit; two reservations; simultaneous stocktake.
   - Data: empty, huge (10k variants), Arabic/French/emoji text, RTL/LTR mixing, leading-zero phones.
   - Money: rounding, discount > total, refund > paid, negative quantities.
   - Permissions: every role x every endpoint.
   - Operability: could I debug this at 2am from logs alone?
5. FIX what the pass found. RE-VERIFY from step 3. Repeat until clean.
6. TEST-QUALITY CHECK on critical modules (stock, money, billing, RLS): deliberately break the logic (mutation check) and confirm tests fail. Record it. Tests that cannot fail are theater.
7. LOG EVIDENCE in `docs/VERIFY.md` (date, phase, command, exit code, key output lines). Commit (conventional commits) and tag the phase.
Rules: never mark anything done with a failing or skipped test. Never weaken, delete, or skip tests to get green. Never mock the thing under test. Fix flaky tests, do not blindly retry. If something cannot be verified in this environment, label it UNVERIFIED-IN-ENV, add it to the release blockers, and make CI cover it (`.github/workflows/ci.yml` runs the full suite incl. Playwright E2E, axe, security scans, load smoke).

## 8. GLOBAL DEFINITION OF DONE (for each phase and for release)
- `pnpm verify` green; CI green; zero high/critical audit findings; zero secrets found.
- All UAT scenarios assigned to the phase pass (scripted, repeatable, evidence logged).
- RLS/tenant isolation suite and role matrix suite green.
- No TODO/FIXME/placeholder/fake data in shipped paths. No `any`. No swallowed errors.
- Every user-facing string exists in ar and fr. No hardcoded strings.
- Migrations tested both fresh and on a populated database. Rollback plan documented.
- Docs updated (SPEC, ARCHITECTURE, DECISIONS, RUNBOOK, PROGRESS, VERIFY).

## 9. PERFORMANCE AND RELIABILITY TARGETS
- POS sale endpoint p95 < 300 ms at 50 rps on 2 vCPU / 2 GB. Product search < 150 ms with 20k variants. Product list page < 500 ms. Import of 5,000 variants < 60 s.
- Offline: 200 queued sales sync with zero duplicates and correct stock.
- Backup: nightly encrypted `pg_dump` to off-site storage, retention 7 daily / 4 weekly / 6 monthly, automated restore test, restore drill documented (RPO <= 24h; WAL archiving in backlog).
- `/api/health` and `/api/ready` endpoints. Error tracking hook. Uptime check documented.

## 10. PHASES AND EXIT CRITERIA
P0 Foundation of the repo: env probe, repo, tooling, `scripts/verify.sh`, CI workflow, docs skeleton, SPEC.md refined from this file, DECISIONS.md. Exit: `pnpm verify` green on a minimal app; Postgres up; a tenant-isolation hello-test passes.
P1 Core platform: tenants, users, memberships, roles, auth, sessions, RLS + `withTenant`, audit log, i18n + RTL shell, design system, settings (shop profile, tax, receipt header), rate limiting, jobs, email abstraction. Exit: isolation + auth-security + role-matrix suites green. HUMAN CHECKPOINT.
P2 Catalog: products, variants matrix, barcodes, images, categories/brands/suppliers, import/export with preview and rollback, barcode labels. Exit: 5,000-variant import within target; UAT 1 partial.
P3 Inventory: locations, ledger, levels, reservations, adjustments, transfers, purchases and receiving, stocktake, valuation, low-stock. Exit: property tests for INV-1/2/3/7; UAT 2, 9.
P4 POS + register + offline: Exit: UAT 3, 4, 5, 8, 10; load and offline targets met. HUMAN CHECKPOINT (owner tests on a real phone and a real barcode scanner).
P5 Online orders and logistics: Exit: UAT 5, 6, 7; adapter contract tests with recorded fixtures; real sandbox verification wherever the human provides credentials. HUMAN CHECKPOINT.
P6 Finance and reports: Exit: UAT 11; every report reconciles with fixture-computed expected values.
P7 SaaS layer: plans, entitlements, trial, state machine, manual payments, Chargily, super-admin, onboarding, landing, export/delete. Exit: UAT 1, 12, 14, 16.
P8 Hardening and release: ASVS L2 checklist pass, scripted attack suite, dependency audit, load/perf, backup/restore drill, accessibility (axe), legal drafts, deploy artifacts (Dockerfile, compose, Caddy, env template, runbook), full regression of all UAT. Exit: `docs/RELEASE_READINESS.md` with evidence for every gate; wait for the human's "GO PROD". HUMAN CHECKPOINT.
Scope control: anything not in section 2 goes to `docs/BACKLOG.md`. No gold plating.

## 11. UAT SCENARIOS (script them; run them; log them)
1. Onboard a tenant: sign up, trial starts, create shop, import 200 products with variants, print barcode labels.
2. Receive a supplier purchase of 50 pieces across sizes: stock and weighted average cost update correctly.
3. POS: sell 3 items, mixed cash + credit; customer debt recorded; receipt prints; stock decrements.
4. Offline: disconnect, make 5 sales, reconnect: no duplicates, correct stock, receipt sequences intact.
5. Race: last unit of M/Black sold at POS and ordered online at the same time: behavior follows the documented policy, ledger stays consistent.
6. Online order lifecycle with a mocked courier: new, confirm (reserve), ship (label, deduct), delivered, COD remittance reconciled.
7. Return: delivered then returned: restock to the right location, ledger and totals correct.
8. Exchange at the shop (size swap) in one flow.
9. Stocktake of 30 variants: differences become reasoned adjustments.
10. Register close: expected vs counted, difference logged, Z report correct.
11. A month of seeded expenses and sales: P&L equals the hand-computed value.
12. Roles: a cashier cannot see cost/profit, cannot void a sale, cannot export; a manager can; permissions enforced server-side (not just hidden in UI).
13. Tenant isolation attack: tenant A tries tenant B's IDs on every endpoint and every file URL: always 403/404.
14. Subscription: trial expiry, read-only mode, manual payment approved, reactivation; Chargily webhook replay is safe; forged webhook rejected.
15. Backup, wipe, restore: app passes smoke tests and invariants hold.
16. Full tenant export and tenant deletion workflow.
17. Language switch ar/fr on every page; RTL correctness; numbers, dates, currency formats.
18. Duplicate order and risky-customer detection fire correctly.

## 12. ESCALATION AND FORBIDDEN
Ask the human ONLY for: credentials/API keys/sandbox accounts, legal or tax decisions, pricing/brand/domain, irreversible or production actions, contradictions in the spec that change the data model. Everything else: decide, then log the decision and reasoning in `docs/DECISIONS.md`.
Forbidden: floats for money; `any`; string-concatenated SQL; secrets in git or logs; disabling RLS "temporarily"; swallowing errors; shipping placeholders or fake data; deploying to production without the human's explicit "GO PROD"; scraping; sending customer PII to third parties other than the selected courier; claiming completion without evidence.

## 13. DOCS AND RESUME PROTOCOL
Maintain: `docs/SPEC.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `PROGRESS.md` (phase table + status + next action), `VERIFY.md` (evidence), `RISKS.md`, `RUNBOOK.md`, `UAT.md`, `BACKLOG.md`, `RELEASE_READINESS.md`.
Resume Protocol (start of EVERY session, and after any context compaction): read AGENTS.md, then `docs/PROGRESS.md`, then the last 50 lines of `docs/VERIFY.md`; run `pnpm verify` to see the real current state; continue from the recorded next action. Before ending a session: update PROGRESS.md, commit, and print a status report.
Status report to the human: Modern Standard Arabic, max 12 lines: what was completed, evidence (counts of passing tests/UAT), what is blocked or needs the human, next step, and "what to test on your phone now" when a checkpoint is reached.

======================================================================
# PART 2 — KICKOFF MESSAGE (paste once in the first session)
======================================================================

Read AGENTS.md completely. You own this product end to end.
Start with Phase P0. Do these in order, without asking me questions unless AGENTS.md section 12 says you must:
1. Probe the environment and write the results and adaptations into docs/DECISIONS.md.
2. Initialize the repository, tooling, `scripts/verify.sh`, the CI workflow, and the docs skeleton. Refine docs/SPEC.md from AGENTS.md sections 2-4 and 11, turning each acceptance statement into a testable checklist.
3. Create the minimal app with Postgres, migrations, the `withTenant` wrapper with RLS, and a tenant-isolation test that provably fails if RLS is disabled.
4. Run `pnpm verify`, perform the red-team pass, fix, re-verify, log evidence in docs/VERIFY.md, commit and tag `p0-done`.
5. Then continue to P1 and proceed phase by phase following the loop in section 7. Stop at every HUMAN CHECKPOINT with an Arabic status report and wait for my confirmation. Between checkpoints keep going autonomously.
Your first reply must be only: (a) the environment findings in 5 lines, (b) the P0 test list you will write first, (c) any blocker you need from me. Then start working.
