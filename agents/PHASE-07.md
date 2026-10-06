# BoutiqFlow DZ — Phase 07: Delivery Providers Subsystem (Yalidine, ZR Express, Noest, Maystro)

## 1. Objective
Decoupled courier adapters adhering to the golden rule: Couriers never touch inventory directly.
Courier → Shipment → Order. Courier ↛ Inventory, Courier ↛ Cash Register, Courier ↛ Sale.

## 2. Invariants & Guardrails
- Reference `PROJECT.md` Section 1.5 (`INV-07-01` to `INV-07-20`) for permanent delivery engineering invariants.
- Strict adherence to Principle #0: Personal data protection under Algerian Law 18-07 / 25-11 (`PERSONAL_DATA_TRANSMITTED` processing journal logs & statutory `TransferRecord`).
- No direct stock mutations outside `InventoryService`.
- No floating-point arithmetic for currency (strict BigInt centimes).
- Carrier credentials encrypted at rest with AES-256-GCM.

## 3. Concrete Milestones & Tasks
- [x] Implement BaseDeliveryAdapter unified interface (`src/delivery/adapter.js`)
- [x] Implement Yalidine Express adapter with stopdesk, home delivery, tracking, labels (`src/delivery/adapters/yalidine.js`)
- [x] Implement ZR Express adapter (`src/delivery/adapters/zr_express.js`)
- [x] Implement Noest Express adapter (`src/delivery/adapters/noest.js`)
- [x] Implement Maystro Delivery adapter (`src/delivery/adapters/maystro.js`)
- [x] Implement Generic Private Courier adapter (`src/delivery/adapters/generic.js`)
- [x] Implement FakeDeliveryProvider sandbox simulator (`src/delivery/adapters/sandbox.js`)
- [x] Implement ShipmentService with idempotent create, snapshotting, and timeout recovery (`src/delivery/shipment_service.js`)
- [x] Implement ShipmentEventProcessor with append-only ledger and status regression protection (`src/delivery/event_processor.js`)
- [x] Implement ShipmentReturnService with inspection quarantine and authoritative restock (`src/delivery/returns_service.js`)
- [x] Implement DeliveryReconciliationService for COD collections and remittance settlements (`src/delivery/reconciliation_service.js`)
- [x] Implement DeliveryRateService for home and stop-desk tariffs across carriers (`src/delivery/rate_service.js`)
- [x] Enforce decoupling: Courier -> Shipment -> Order; Courier ↛ Inventory, Courier ↛ Cash

## 4. Verification & Exit Criteria
- Automated test command: `bash scripts/verify.sh`
- All 8 Phase 07 test suites pass 100% (44/44 tests passing).
- Complete verification suite passes with zero failures (342/342 tests passing across 52 suites).
- GATE 07 = GREEN.
