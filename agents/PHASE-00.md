# BoutiqFlow DZ — Phase 00: Repository Audit, Architecture, Threat Model, Privacy Model, ADR

## 1. Objective
Complete inspection of environment, directory structure, PostgreSQL RLS strategy, Law 18-07/25-11 privacy model, and ADR documentation.

## 2. Invariants & Guardrails
- Reference `PROJECT.md` for permanent engineering invariants.
- Strict adherence to Principle #0: Personal data protection under Algerian Law 18-07 / 25-11.
- No direct stock mutations outside `InventoryDomainService`.
- No floating-point arithmetic for currency.

## 3. Concrete Milestones & Tasks
- [ ] Audit local runtime environment (Node, SQLite, Python, Git)
- [ ] Establish PROJECT.md and BUILD_STATUS.md
- [ ] Document ARCHITECTURE.md, PRIVACY.md, SECURITY.md, DATA_MODEL.md, INVENTORY.md, OFFLINE_SYNC.md, DELIVERY.md, COD.md, DECISIONS.md

## 4. Verification & Exit Criteria
All architecture and regulatory documents authored and verified against Algerian retail reality.
- Automated test command: `bash scripts/verify.sh`
- Once all tests pass and evidence is logged in `docs/VERIFY.md`, update `docs/BUILD_STATUS.md` and proceed to Phase 01.
