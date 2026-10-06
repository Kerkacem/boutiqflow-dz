# BoutiqFlow DZ — Phase 08: Offline Sync + Conflict Resolution + Durable Queue

## 1. Objective
Build an offline-first architecture for POS and permissible local operations adhering to the core principle:
LOCAL ≠ SOURCE OF TRUTH; SERVER = authoritative state; LOCAL = durable pending operations + local UX state.
System withstands: offline → sale → browser refresh → browser restart → device restart → reconnect → timeout → duplicate retry → concurrent mutation without duplicating mutations or creating negative stock.

## 2. Invariants & Guardrails
- Reference `PROJECT.md` Section 1.6 (`INV-08-01` to `INV-08-25`) for permanent offline sync invariants.
- Strict Capability Matrix: Only POS_SALE, PAYMENT_RECORD, RECEIPT_GENERATION, CASH_SESSION_LOCAL_STATE allowed offline. All other operations strictly disallowed offline (`INV-08-11`, `INV-08-24`).
- Tenant-bound revocable POS devices (`INV-08-17`, `INV-08-23`).
- Globally unique `operationId` + deterministic `requestHash` payload check. Tampered replays rejected with `IDEMPOTENCY_KEY_REUSE` (`INV-08-01`, `INV-08-02`, `INV-08-03`).
- Multi-tab local outbox with recoverable leases (`INV-08-22`). Crash survival across browser/process restart (`INV-08-05`, `INV-08-06`).
- Authoritative inventory & stock conflict resolution: Zero negative stock (`INV-08-16`). No last-write-wins for financial or stock conflicts (`INV-08-15`). Bounded offline risk via server-authorized `offlineAllowance` budget (`INV-08-25`).
- Offline thermal receipt with `LOCAL/PENDING` indicator mapped to server sale upon sync (`INV-08-18`).

## 3. Concrete Milestones & Tasks
- [x] Database Schema: Added `devices`, `processed_operations`, `offline_stock_allowances`, `sync_conflicts`, `local_outbox` tables with immutability rules (`src/db/client.js`)
- [x] Defined Offline Constants & Capability Matrix (`src/offline/constants.js`)
- [x] Operation Identity & Payload Hash Engine (`src/offline/operation_identity.js`)
- [x] POS Device Identity & Revocation Service (`src/offline/device_service.js`)
- [x] Stock Allowance & Reservation Budget Service (`src/offline/stock_allowance.js`)
- [x] Durable Local Outbox Queue with Recoverable Leases (`src/offline/local_outbox.js`)
- [x] Authoritative Sync Engine with Idempotent Replay & Conflict Detection (`src/offline/sync_engine.js`)
- [x] Controlled Conflict Resolution Service for Managers (`src/offline/conflict_service.js`)
- [x] Offline Receipt Engine with Mapping (`src/offline/offline_receipt.js`)
- [x] Telemetry Metrics without Credential or PII Exposure (`src/offline/metrics.js`)
- [x] 9 Dedicated Test Suites covering all scenarios and chaos tests (`tests/phase08_*.test.js`)

## 4. Verification & Exit Criteria
- Automated test command: `bash scripts/verify.sh`
- All 9 Phase 08 test suites pass 100% (36/36 tests passing).
- Complete verification suite passes with zero failures (378/378 tests passing across 61 suites).
- GATE 08 = GREEN.
