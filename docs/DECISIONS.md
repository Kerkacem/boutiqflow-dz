# MAHAL — Architecture Decision Records (ADRs)

## ADR-001: Environment Adaptations & Execution Strategy
- **Status:** Accepted
- **Context:** The development environment is running on Debian 12 (Linux 4.19 gVisor container) with Node.js v18.20.4, npm 9.2.0, Bun v1.1.0 (`/working_dir/bin/bun`), and Python 3.11 with SQLite 3.40.1. No outbound internet access is permitted. Native PostgreSQL server (`psql`/`postgres`) and `pnpm` are not pre-installed in this local container.
- **Decision:**
  1. For local testing and development in this environment:
     - Provide a shim for `pnpm` (`scripts/pnpm-shim.sh`) aliased/executable so commands like `pnpm verify` execute smoothly using the local engine/node/bun test runners.
     - Implement an in-memory SQL/Postgres emulation layer for local unit and isolation testing, labeling local database test runs as `UNVERIFIED-AGAINST-REAL-PG` in `docs/VERIFY.md` as required by AGENTS.md section 3.
     - Target full verification against real PostgreSQL 15+ service containers and headless Chromium/Playwright in the GitHub Actions CI pipeline (`.github/workflows/ci.yml`).
  2. All SQL schema files, migrations, and RLS policies are strictly authored in PostgreSQL 15+ standard DDL with `ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, `SET LOCAL app.tenant_id`, and `app.user_id`.
- **Consequences:** Local tests execute fast and deterministically offline; real Postgres tests and Playwright E2E run in CI.

## ADR-002: Multi-Tenancy Scoping & Defense-in-Depth
- **Status:** Accepted
- **Context:** AGENTS.md section 4 requires multi-tenancy to be enforced twice: at the application level via `withTenant()` and at the database level via PostgreSQL Row Level Security (RLS) with composite foreign keys `(tenant_id, id)`.
- **Decision:**
  1. Every database table (except global reference tables) MUST contain `tenant_id UUID NOT NULL`.
  2. Foreign keys referencing tenant tables must be composite `(tenant_id, target_id) REFERENCES target_table(tenant_id, id)` ensuring tenant boundaries cannot be crossed even via broken application references.
  3. Every transaction executes `SET LOCAL app.tenant_id = '<tenant_id>'` and `SET LOCAL app.user_id = '<user_id>'`.
  4. RLS policies enforce `tenant_id = current_setting('app.tenant_id', true)::uuid`.
  5. Application layer encapsulates all tenant operations in `withTenant(tenantContext, async (tx) => { ... })`.
- **Consequences:** An accidental missing `WHERE tenant_id = ...` in an ad-hoc query is blocked by PostgreSQL RLS.

## ADR-003: Monetary Calculations (Bigint Centimes)
- **Status:** Accepted
- **Context:** Floating point precision errors in currency calculations lead to fiscal drift and reconcile discrepancies.
- **Decision:** All prices, costs, totals, and balances are stored as integers in Algerian centimes (1 DZD = 100 centimes). Fractions of centimes are rounded using half-even (banker's rounding) before persisting. Whole Algerian Dinars (DA) are computed for display only by dividing by 100.
- **Consequences:** Zero floating-point rounding errors across registers, carts, and invoices.


## ADR-004: Single Authoritative Inventory Domain Service
- **Status:** Accepted
- **Context:** Uncoordinated direct stock modifications (`products.stock = products.stock - 1`) across POS checkouts, returns, order confirmations, and transfers create severe race conditions and untraceable inventory drift.
- **Decision:** All inventory balance updates must execute exclusively through a single authoritative domain service (`src/inventory/ledger.js`). Every mutation appends an immutable record to `stock_movements`. The cached balances maintain the invariants: $OnHand = \sum Quantity_{movements}$ and $Available = OnHand - Reserved$ ($Available \le OnHand$).
- **Consequences:** Eliminates double deductions, untracked inventory shrinkage, and race conditions during simultaneous physical and online checkouts.

## ADR-005: Offline-First POS Outbox Architecture
- **Status:** Accepted
- **Context:** Algerian retail commercial districts experience frequent, unpredictable internet drops. Physical checkout must never be interrupted.
- **Decision:** The POS application stores sales transactions locally in browser IndexedDB using an append-only outbox queue with monotonic per-register receipt sequencing (`R1-000101`). Upon reconnection, transactions sync sequentially to the backend. The backend enforces idempotency using `idempotency_keys` with unique `(tenant_id, key)` constraints.
- **Consequences:** High-speed offline operation with guaranteed zero duplicate transactions on reconnection.

## ADR-006: Algerian Payment Realism (Manual BaridiMob / CCP & Chargily Pay V2)
- **Status:** Accepted
- **Context:** True automated recurring card billing does not exist natively for small Algerian merchants without specialized SATIM CIB web-merchant certification. Claiming automated monthly recurring card charges would be fraudulent.
- **Decision:** The initial SaaS subscription billing engine operates on a manual renewal workflow (submitting BaridiMob/CCP transaction receipt slips for admin review and activation) paired with a Chargily Pay V2 hosted checkout webhook integration with HMAC-SHA256 signature verification. A clean provider abstraction interface is maintained for future certified SATIM CIB integration.
- **Consequences:** 100% operational transparency without false claims of unattainable payment automation.

## ADR-007: Algerian Data Privacy Compliance (Law 18-07 & Law 25-11)
- **Status:** Accepted
- **Context:** Algerian Law 18-07 on personal data protection was significantly updated and amended by Law 25-11 on July 24, 2025. SaaS systems handling customer and merchant data in Algeria must prioritize data minimization, security, and portability.
- **Decision:** BoutiqFlow DZ stores only minimal customer delivery information (name, normalized phone, Wilaya, commune, delivery address). No third-party behavioral trackers or ad pixels are integrated. Full data export and a 30-day soft-deletion retention period are built natively into the platform.
- **Consequences:** Solid architectural privacy posture, avoiding regulatory non-compliance while advising formal legal review.

## ADR-008: Channel Connector Subsystem (Shopify & WooCommerce)
- **Status:** Accepted
- **Context:** Algerian retailers often manage storefronts on Shopify or WooCommerce in addition to physical stores, but external platforms must not overwrite central store inventory arbitrarily.
- **Decision:** Channel connectors implement a strict adapter pattern (`src/connectors/adapter.js`). BoutiqFlow DZ's central inventory ledger remains the authoritative source of truth. Order mapping is SKU-first. Any external order line item with an unmatched SKU is routed to an `UNMAPPED ITEMS` triage queue rather than guessing or silently discarding.
- **Consequences:** External sales channels synchronize cleanly without corrupting physical store stock.
