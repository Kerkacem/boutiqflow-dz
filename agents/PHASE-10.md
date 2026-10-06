# BoutiqFlow DZ — Phase 10: Integrations + Public API

## 1. Objective
Build a unified, robust, and secure Integration Layer and Public REST API (`/api/v1/`) connecting external e-commerce platforms (Shopify, WooCommerce) and public developers to BoutiqFlow without compromising core domain authority.
Core Golden Rule: **Integration is an adapter, not a backdoor into the domains.**
$External\ Platform \rightarrow Integration\ Adapter \rightarrow BoutiqFlow\ Domain\ Services$. Never: $External\ Platform \rightarrow Database$.

## 2. Invariants & Guardrails
- Reference `PROJECT.md` Section 1.8 (`INV-10-01` to `INV-10-28`) for permanent integration engineering invariants.
- **BoutiqFlow Authority (`INV-10-02`):** BoutiqFlow remains the authoritative source of truth for products, variants, SKUs, barcodes, inventory stock levels, purchases, costs, cash drawers, and financial history.
- **Unidirectional Inventory Projection (`INV-10-10`):** Sync is $BoutiqFlow \rightarrow External\ Projection$. External platforms cannot overwrite local stock blindly; stale external events are rejected with `STALE_EXTERNAL_EVENT`.
- **Shopify Modern Architecture (`INV-10-26`):** Modern GraphQL Admin API (`SHOPIFY_API_VERSION = '2025-01'`) with least-privilege scopes. REST Admin API is avoided as legacy.
- **WooCommerce Standard (`INV-10-13`):** Official REST API v3 (`/wp-json/wc/v3/`) with Consumer Key / Secret pairs and HMAC-SHA256 webhook signatures.
- **Public API Security & Isolation (`INV-10-16`, `INV-10-17`):** Versioned `/api/v1/` endpoints. Scoped, revocable API keys using SHA-256 hashed secrets at rest. Tenant boundary is dictated strictly by authenticated API key context; client requests attempting to override `tenantId` in queries or payloads are rejected (`403 FORBIDDEN`).
- **Request Idempotency (`INV-10-07`, `INV-10-18`):** All public mutations accept `Idempotency-Key`. Replaying identical keys with identical payloads returns cached responses; replaying with tampered payloads is rejected (`409 IDEMPOTENCY_KEY_REUSE`).
- **Inbound Order Import Idempotency (`INV-10-06`, `INV-10-24`):** Multiple webhook deliveries or polling passes for order #100 produce exactly 1 `OnlineOrder`, 0 duplicate reservations, and 0 cash drawer mutations for online-paid orders.
- **Integration Outbox Resilience (`INV-10-08`, `INV-10-09`):** Two-phase decoupling ensures local transaction commits are permanent. External API outages or 500s mark outbox events as `RETRYABLE_FAILURE` without rolling back local sales. Post-crash workers use external lookup recovery to prevent duplicate remote effects.
- **Webhook SSRF Protection (`INV-10-23`):** Outbound webhook destination validation strictly blocks loopback (`127.0.0.1`, `localhost`), cloud metadata (`169.254.169.254`, `metadata.google.internal`), and private RFC 1918 subnets.
- **Cryptographic Outbound Signing (`INV-10-21`):** Outbound webhooks are signed using HMAC-SHA256 (`X-BoutiqFlow-Signature`) with timestamped payloads.
- **Law 25-11 International Data Transfer (`INV-10-25`):** Connecting foreign SaaS platforms (e.g. Shopify in Canada) automatically registers statutory `TransferRecord` entries.

## 3. Concrete Milestones & Tasks
- [x] Database Schema: Added `integrations`, `integration_credentials`, `integration_mappings`, `integration_events`, `integration_outbox`, `public_api_keys`, `public_idempotency_keys`, `webhook_subscriptions`, and `outbound_webhook_deliveries` tables with immutability enforcement on event journals (`src/db/client.js`).
- [x] Cryptographic & Security Utilities: Implemented AES-256-GCM encryption/decryption at rest, HMAC-SHA256 signing and verification, SHA-256 secret hashing, and deterministic payload hashing (`src/integrations/crypto_service.js`).
- [x] Provider Abstraction & Capability Matrix: Defined `BaseCommerceAdapter` with explicit capability assertions (`CAPABILITY_NOT_SUPPORTED`) (`src/integrations/adapters/base.js`, `constants.js`).
- [x] Shopify GraphQL Admin API Adapter: Configured version `2025-01`, least-privilege scope validation, HMAC-SHA256 webhook verification, canonical order normalization, inventory projection mutations, and fulfillment creation (`src/integrations/adapters/shopify_graphql.js`).
- [x] WooCommerce REST API v3 Adapter: Configured `/wp-json/wc/v3/` endpoint, key format validation, HMAC-SHA256 signature checking, canonical order parsing, and inventory PUT updates (`src/integrations/adapters/woocommerce_rest.js`).
- [x] Integration Service: Tenant-bound account management, AES-256-GCM credential encryption at rest, immediate revocation, and Law 25-11 TransferRecord audit logging (`src/integrations/integration_service.js`).
- [x] Idempotent Order Import Service: Normalizes external orders, resolves variants via SKU or mappings, logs unmapped items to triage queue, creates canonical `OnlineOrder`, and isolates online payments from cash registers (`src/integrations/order_import_service.js`).
- [x] Inventory Projection & Stale Event Protection Service: Projects authoritative available stock ($OnHand - Reserved$) to connected channels and rejects stale incoming external quantity updates (`src/integrations/inventory_projection_service.js`).
- [x] Integration Outbox & Two-Phase Crash Resilience: Enqueues outbound dispatches, prevents local transaction rollbacks on external 500s, and enables lookup recovery post-crash (`src/integrations/integration_outbox.js`).
- [x] Public REST API v1 Service: Manages scoped API keys, enforces tenant boundaries without payload overrides, verifies `Idempotency-Key` headers, and exposes `/api/v1/orders` (`src/integrations/public_api_service.js`).
- [x] Outbound Webhook Delivery & SSRF Guard Service: Strict RFC 1918 / loopback / cloud metadata IP filtering, HMAC-SHA256 payload signing, and bounded 5-attempt retry disabling (`src/integrations/webhook_delivery_service.js`).

## 4. Test Suite & Verification Results
All 12 Phase 10 test suites pass with 100% success (44 tests, 0 failures):
- `tests/phase10_shopify_auth.test.js`: PASS
- `tests/phase10_shopify_webhooks.test.js`: PASS
- `tests/phase10_woocommerce_auth.test.js`: PASS
- `tests/phase10_woocommerce_webhooks.test.js`: PASS
- `tests/phase10_public_api_security.test.js`: PASS (Critical Test 52)
- `tests/phase10_idempotency.test.js`: PASS
- `tests/phase10_external_order_import.test.js`: PASS (Critical Test 49)
- `tests/phase10_inventory_projection.test.js`: PASS (Critical Test 50)
- `tests/phase10_integration_outbox.test.js`: PASS (Critical Test 51)
- `tests/phase10_webhook_ssrf.test.js`: PASS
- `tests/phase10_privacy_transfer.test.js`: PASS
- `tests/phase10_provider_failure.test.js`: PASS

Full regression suite: **83 suites, 457 tests passing, 0 failures**.
**GATE 10 = GREEN.**
