# BoutiqFlow DZ — Comprehensive Chaos & Fault Injection Matrix (Phase 13)

## 1. Overview
The Chaos Matrix defines the fault injection tests executed against BoutiqFlow DZ to verify system resilience, automatic containment, fail-closed boundaries, and deterministic recovery.

---

## 2. Fault Injection Scenarios & Expected System Behavior

| # | Fault Scenario | Injection Mechanism | System Detection & Containment | Verification Assertion |
|---|---|---|---|---|
| **01** | **Database Connection Refused** | Kill DB socket / reject TCP connection | Application enters degraded read-only or queueing mode; mutations fail closed with HTTP 503. | Zero false successes; zero unlogged mutations; automatic reconnection upon recovery. |
| **02** | **Database Latency & Pool Saturation** | Inject artificial 3,000ms delay on DB queries | Connection pool bounds max active clients; requests exceeding timeout fail with explicit error. | No thread exhaustion; no process memory leak; connection pool clears cleanly. |
| **03** | **Worker Killed Mid-Transaction** | `process.kill(workerPid, 'SIGKILL')` after external API call but before DB commit | Transaction atomicity rolls back uncommitted records; idempotent recovery job reconciles remote state. | Zero partial writes; zero duplicate orders; zero duplicate stock reservations. |
| **04** | **Provider API 500 / Outage** | Mock courier or payment provider returning HTTP 500/503 | Circuit breaker trips to `OPEN` state after 5 consecutive failures; outbound worker throttles calls. | No retry storms; committed local boutique sales remain intact; outbox retains pending sync. |
| **05** | **Provider Network Timeout** | Delay provider response beyond timeout threshold (30s) | Request terminates with `TIMEOUT_RETRYABLE`; recorded in outbox with bounded exponential backoff. | Zero orphaned transactions; zero silent drops; exactly 1 logical parcel or payment created. |
| **06** | **Flapping Network Partition** | Intermittently drop 70% of network packets | PWA switches to offline outbox mode; sync engine uses monotonic sequence numbers and leases. | Zero data loss; zero split-brain sales; zero duplicate inventory decrements. |
| **07** | **Malformed Queue Payload** | Corrupt JSON string or inject invalid schema into event stream | Queue parser catches deserialization failure; quarantines payload into Dead Letter Queue (`DeadLetterEvent`). | Stream processing continues uninterrupted; quarantined event logged with root cause. |
| **08** | **Stale / Corrupted Cache** | Mutate entitlement cache key with invalid plan code | Cache entry rejected via cryptographic verification or expired immediately; queries fall back to authoritative DB. | Zero privilege escalation; forged plans rejected with `PLAN_FORGED`. |
| **09** | **Revoked Device Sync Attempt** | POS device registers sales offline, then admin revokes device before sync | Server validates device authorization token during batch sync; rejects payload with `DEVICE_REVOKED`. | Zero stock mutations; zero sales committed from unauthorized hardware. |
| **10** | **Corrupted Backup Archive** | Flip bits in encrypted backup tarball or truncate manifest | Backup restore tool computes SHA-256 and validates GCM auth tag; halts with `CORRUPT_BACKUP_DETECTED`. | Zero partial restores; zero corrupted tables; production state remains untouched. |
| **11** | **Resource Pressure (Huge Payloads)** | Ingest 50MB malicious JSON / CSV upload | Request body size limit (e.g. 5MB) triggers HTTP 413 `Payload Too Large` before memory allocation. | Heap memory stays stable; no OOM crash; server process remains responsive. |
| **12** | **Clock Skew (Client vs Server)** | Submit client timestamp set 30 days in future or past | Server ignores client wall-clock time; records authoritative server timestamp for financial and audit events. | Financial ledger preserves monotonic chronological integrity; no backdated sales. |
| **13** | **Malicious Webhook Replay** | Replay payment or shipment webhook 100 times concurrently | Idempotency guard matches `external_event_id` and payload hash against `billing_provider_events`. | Exactly 1 payment recorded; zero duplicate credits; 99 replays acknowledged as duplicate. |
| **14** | **Offline Allowance Overdraw** | Offline register attempts to sell 10 units when granted allowance was 3 | Server checks remaining allowance on sync; flags `STOCK_CONFLICT` and initiates manager review. | On-hand inventory never becomes negative; warehouse inventory strictly protected. |
| **15** | **Cross-Tenant IDOR Attack** | User A directly invokes mutations on User B resources | Multi-tenant context rejects query before business logic; returns HTTP 404/403. | Zero foreign record disclosures; zero cross-tenant mutations. |
