import os

phases = [
  ('00', 'Repository Audit, Architecture, Threat Model, Privacy Model, ADR',
   'Complete inspection of environment, directory structure, PostgreSQL RLS strategy, Law 18-07/25-11 privacy model, and ADR documentation.',
   ['Audit local runtime environment (Node, SQLite, Python, Git)',
    'Establish PROJECT.md and BUILD_STATUS.md',
    'Document ARCHITECTURE.md, PRIVACY.md, SECURITY.md, DATA_MODEL.md, INVENTORY.md, OFFLINE_SYNC.md, DELIVERY.md, COD.md, DECISIONS.md'],
   'All architecture and regulatory documents authored and verified against Algerian retail reality.',
   'bash scripts/verify.sh'),

  ('01', 'Auth, Multi-Tenancy, RBAC, Tenant Isolation',
   'Implement secure authentication, session management, and dual-layer multi-tenancy with strict RBAC.',
   ['Implement withTenant() transaction wrapper with SET LOCAL app.tenant_id',
    'Enforce FORCE ROW LEVEL SECURITY across all tenant tables',
    'Implement salted PBKDF2/Argon2id password hashing and session tokens',
    'Enforce RBAC matrix (Cashier denied cost price and profit visibility)',
    'Implement append-only business audit logging'],
   'Tests pass: tests/tenant_isolation.test.js, tests/with_tenant.test.js, tests/rbac_matrix.test.js, tests/auth_security.test.js, tests/audit_log.test.js.',
   'node --test tests/tenant_isolation.test.js tests/with_tenant.test.js tests/rbac_matrix.test.js tests/auth_security.test.js tests/audit_log.test.js'),

  ('02', 'Products, Variants, SKU, Barcodes & Import',
   'Clothing catalog with first-class Color x Size Cartesian variant matrix and bulk import.',
   ['Model product template and physical variant hierarchy',
    'Generate Cartesian product matrix for sizes (S-XXL) and colors',
    'Implement EAN-13 barcode generator with prefix 20-29 and Modulo-10 checksum',
    'Implement bulk CSV importer with row-level error reporting and zero-row atomic rollback',
    'Implement 58/80mm thermal barcode label generation'],
   'Tests pass: tests/catalog_p2.test.js with 100% atomic rollback on corrupted input.',
   'node --test tests/catalog_p2.test.js'),

  ('03', 'Authoritative Inventory Ledger, Reservations & Concurrency',
   'Build the single authoritative Inventory Domain Service.',
   ['Implement applyStockMovement() with append-only stock_movements ledger',
    'Enforce INV-1: on_hand == SUM(movements)',
    'Enforce INV-2: available = on_hand - reserved (available <= on_hand)',
    'Implement atomic location transfers (Warehouse <-> Boutique)',
    'Implement Weighted Average Cost (WAC / PMP) recalculation on purchase receipt',
    'Implement physical stocktake discrepancy reconciliation with audit reasons'],
   'Tests pass: tests/inventory_p3.test.js with zero direct stock mutations.',
   'node --test tests/inventory_p3.test.js'),

  ('04', 'POS Register, Cash Control, Split Payments & Offline Printing',
   'High-speed physical store checkout with cash drawer control and local receipt printing.',
   ['Implement POS checkout with barcode scanner wedge lookup (< 100ms)',
    'Implement split tenders (Cash, CIB, Edahabia, BaridiMob, Customer Credit)',
    'Implement atomic in-store size/color exchange in single transaction',
    'Implement cash register shift opening, mid-shift cash-in/out, and Z-report closing with variance calculation',
    'Implement ReceiptPrinter abstraction (Browser, ESC/POS USB, ESC/POS Network, Bluetooth) for offline local printing'],
   'Tests pass: tests/pos_p4.test.js and tests/printer.test.js.',
   'node --test tests/pos_p4.test.js tests/printer.test.js'),

  ('05', 'Purchases, Suppliers, Customer Returns, Expenses & True Profit',
   'Store accounting, supplier POs, categorized operational expenses, and exact P&L.',
   ['Record supplier purchases and update WAC in integer centimes',
    'Implement customer return inspection (resalable restock vs damaged write-off)',
    'Implement categorized operational expenses (rent, electricity, salaries, ads, transport)',
    'Calculate true P&L: Gross Sales - Returns - COGS (via snapshot) - Expenses = Net Profit',
    'Detect dead stock (items unsold for 60+ days) and size-curve sell-through'],
   'Tests pass: tests/finance_p6.test.js reconciling mathematically to the centime.',
   'node --test tests/finance_p6.test.js'),

  ('06', 'COD Confirmation Domain & Online Order Lifecycle',
   'Dedicated phone/WhatsApp confirmation state machine and automated stock reservations.',
   ['Implement COD confirmation state machine (PENDING, CALLING, CONFIRMED, UNREACHABLE, REFUSED, CANCELLED)',
    'Log call attempts with timestamp, agent, channel, and scheduled retry',
    'Trigger atomic stock reservation exclusively upon order confirmation',
    'Release reservation immediately if order is cancelled prior to shipment',
    'Detect 24h duplicate orders and flag risky customer history'],
   'Tests pass: tests/orders_p5.test.js and tests/cod_confirmation.test.js.',
   'node --test tests/orders_p5.test.js tests/cod_confirmation.test.js'),

  ('07', 'Delivery Providers Subsystem (Yalidine, ZR Express, Noest, Maystro)',
   'Decoupled courier adapters adhering to the golden rule: Couriers never touch inventory directly.',
   ['Implement BaseCourierAdapter interface',
    'Implement Yalidine Express adapter (stopdesk, home delivery, tracking, labels)',
    'Implement ZR Express adapter',
    'Implement Noest Express adapter',
    'Implement Maystro Delivery adapter',
    'Implement Generic Private Courier adapter',
    'Enforce decoupling: Courier -> Order Service -> Inventory Domain'],
   'Tests pass: tests/orders_p5.test.js verifying courier contracts and inventory decoupling.',
   'node --test tests/orders_p5.test.js'),

  ('08', 'Offline Synchronization, Conflict Resolution & Idempotency',
   'Resilient PWA offline queue and zero-loss server reconciliation.',
   ['Implement IndexedDB outbox queue with monotonic per-register receipt sequencing',
    'Implement server-side idempotency verification using idempotency_keys(tenant_id, key)',
    'Implement conflict resolution: in-store physical sale takes precedence over unconfirmed online order',
    'Verify zero double sales or duplicate stock movements on reconnection retry'],
   'Tests pass: tests/pos_p4.test.js UAT-4 offline chaos test.',
   'node --test tests/pos_p4.test.js'),

  ('09', 'Executive Dashboard, Reports & Analytics',
   'Real-time operational visibility for the boutique owner.',
   ['Generate daily dashboard KPIs (Sales, Net Profit, Orders count, Drawer cash, Stock value)',
    'Generate sales by size and color reports',
    'Generate cashier performance and cash variance reports',
    'Generate customer credit aging buckets (0-30d, 31-60d, 60d+)',
    'Export reports to CSV and printable formats'],
   'Tests pass: tests/finance_p6.test.js and dashboard verification.',
   'node --test tests/finance_p6.test.js'),

  ('10', 'Omnichannel Connectors (Shopify, WooCommerce, Generic REST API)',
   'External sales channel synchronization with BoutiqFlow DZ authoritative central inventory.',
   ['Implement BaseChannelConnector with connect, disconnect, and credential validation',
    'Implement Shopify connector with HMAC-SHA256 signature verification',
    'Implement WooCommerce connector with consumer key auth and webhook verification',
    'Enforce SKU-first product/variant resolution',
    'Route unmatched external items to UNMAPPED ITEMS triage queue (no silent guessing)',
    'Broadcast updated available stock to connected storefronts upon central inventory movement'],
   'Tests pass: tests/connectors.test.js.',
   'node --test tests/connectors.test.js'),

  ('11', 'Privacy & Compliance (Law 25-11 / Law 18-07)',
   'Built-in compliance module for Algerian personal data protection regulation.',
   ['Implement Register of Processing Activities (processing_register)',
    'Implement Automated Processing Journal (carnet_automatisé / processing_journal)',
    'Implement Incident & Breach Management module with 5-day ANPDP notification tracking',
    'Implement immediate processor-to-controller breach notification workflow',
    'Implement international data transfer controls and residency configuration',
    'Implement full tenant data portability export and 30-day soft-deletion grace window',
    'Implement field-level personal data masking by role'],
   'Tests pass: tests/compliance_privacy.test.js and tests/saas_p7.test.js UAT-16.',
   'node --test tests/compliance_privacy.test.js tests/saas_p7.test.js'),

  ('12', 'SaaS Management, Subscriptions, Billing & Super-Admin',
   'Multi-tier plans, manual BaridiMob/CCP billing, Chargily Pay V2, and isolated /admin console.',
   ['Implement 3 subscription plans (Starter 1,490 / Pro 2,990 / Business 5,990 DZD) + Founder offer',
    'Implement 14-day trial state machine with grace period and read-only gating',
    'Implement manual BaridiMob / CCP bank receipt upload and admin approval workflow',
    'Implement Chargily Pay V2 webhook processing with HMAC signature and replay immunity',
    'Implement isolated /admin portal with audited tenant impersonation'],
   'Tests pass: tests/saas_p7.test.js UAT-14.',
   'node --test tests/saas_p7.test.js'),

  ('13', 'Security Hardening, Chaos Testing, Backup & Disaster Recovery',
   'Attack resistance, pentest suite, and encrypted backup/restore drill.',
   ['Execute scripted IDOR penetration attacks across all database tables',
    'Execute mass assignment and tenant tampering injection attacks',
    'Execute role boundary and privilege escalation penetration checks',
    'Perform disaster recovery drill: AES-256 backup, complete DB wipe, restore, and invariant verification'],
   'Tests pass: tests/security_attack_p8.test.js (UAT-13, UAT-15).',
   'node --test tests/security_attack_p8.test.js'),

  ('14', 'Production Audit & Final Release Sign-Off (GO / NO-GO)',
   'Comprehensive verification across all gates and final release readiness sign-off.',
   ['Run full verification suite: bash scripts/verify.sh',
    'Verify zero linter errors, zero type errors, zero secrets in git',
    'Verify all 12 invariants hold under stress',
    'Verify BUILD_STATUS.md is current and green',
    'Provide production deployment artifacts (Dockerfile, docker-compose, Caddyfile, .env.example)',
    'Issue formal GO / NO-GO recommendation to Belkacem'],
   'Final production sign-off recorded in docs/RELEASE_READINESS.md.',
   'bash scripts/verify.sh')
]

os.makedirs('agents', exist_ok=True)
for code, title, objective, tasks, exit_criteria, test_cmd in phases:
    tasks_md = '\n'.join([f'- [ ] {t}' for t in tasks])
    next_phase = f'Phase {int(code)+1:02d}' if int(code) < 14 else 'Release Complete'
    content = f"""# BoutiqFlow DZ — Phase {code}: {title}

## 1. Objective
{objective}

## 2. Invariants & Guardrails
- Reference `PROJECT.md` for permanent engineering invariants.
- Strict adherence to Principle #0: Personal data protection under Algerian Law 18-07 / 25-11.
- No direct stock mutations outside `InventoryDomainService`.
- No floating-point arithmetic for currency.

## 3. Concrete Milestones & Tasks
{tasks_md}

## 4. Verification & Exit Criteria
{exit_criteria}
- Automated test command: `{test_cmd}`
- Once all tests pass and evidence is logged in `docs/VERIFY.md`, update `docs/BUILD_STATUS.md` and proceed to {next_phase}.
"""
    filename = f'agents/PHASE-{code}.md'
    with open(filename, 'w') as f:
        f.write(content)
    print(f'Wrote {filename}')
