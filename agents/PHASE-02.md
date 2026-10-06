# BoutiqFlow DZ — Phase 02: Products, Variants, SKU, Barcodes & Import

## 1. Objective
Clothing catalog with first-class Color x Size Cartesian variant matrix and bulk import, strictly decoupled from the Inventory Domain.

## 2. Invariants & Guardrails
- Reference `PROJECT.md` for permanent engineering invariants.
- Strict adherence to Principle #0: Personal data protection under Algerian Law 18-07 / 25-11.
- Invariant INV-P02-08: Zero stock mutations occur during Product/Variant CRUD or bulk import.
- No floating-point arithmetic for currency.

## 3. Concrete Milestones & Tasks
- [x] Model product template and physical variant hierarchy (Variant is the sole stock-bearing entity)
- [x] Generate Cartesian product matrix for sizes (S-XXL) and colors
- [x] Implement EAN-13 barcode generator with prefix 20-29 and Modulo-10 checksum
- [x] Implement bulk CSV importer with row-level error reporting and zero-row atomic rollback
- [x] Handle Arabic and French product titles, decimal numbers, and duplicate detection
- [x] Implement 58/80mm thermal barcode label generation
- [x] Enforce INV-P02-01 (SKU uniqueness per tenant) and INV-P02-02 (Barcode uniqueness per tenant)
- [x] Enforce INV-P02-07 (Cashier denied cost fields and price modification)
- [x] Enforce INV-P02-08 (Zero inventory side-effects in catalog CRUD verified by tests/phase02_no_inventory_side_effect.test.js)
- [x] Enforce INV-P02-09 (Historical transaction integrity preserved on deletion)

## 4. Verification & Exit Criteria
- Tests pass: tests/catalog_p2.test.js, tests/phase02_no_inventory_side_effect.test.js, tests/phase02_catalog_invariants.test.js.
- Automated test command: `bash scripts/verify.sh`
- Once all tests pass and evidence is logged in `docs/VERIFY.md`, update `docs/BUILD_STATUS.md` and proceed to Phase 03.
- **GATE 02 STATUS: GREEN**
