# BoutiqFlow DZ — Performance Modeling & Latency Service Level Objectives (SLOs)

## 1. Workload Model & Retail Traffic Characteristics
BoutiqFlow DZ is designed to handle high-concurrency retail peaks characteristic of the Algerian clothing market (e.g. Ramadan shopping rushes, Eid sales, Black Friday, and seasonal inventory turnover).

### Production Workload Baseline
- **Active Tenants**: 500+ independent retail boutiques
- **Active POS Terminals**: 1,500+ concurrent in-store registers
- **In-Store Sales Velocity**: 50 to 100 sales/sec across tenant base
- **E-Commerce Order Ingestion**: 200 to 500 orders/minute during campaign drops
- **Carrier & Marketplace Webhooks**: 50 to 150 incoming events/sec
- **Offline PWA Reconnection Bursts**: 20 to 50 queue flushes/sec following local internet recovery

---

## 2. Service Level Objectives (SLOs)

| Operation Category | Specific Endpoint / Operation | p50 Target | p95 Target | p99 Target | Error Rate SLO |
|---|---|---|---|---|---|
| **Critical POS Checkout** | `POST /sales` (commit, payment, inventory) | $\le$ 45 ms | $\le$ 120 ms | $\le$ 250 ms | < 0.01% |
| **Barcode Scan / Lookup** | `GET /variants/by-barcode` | $\le$ 15 ms | $\le$ 40 ms | $\le$ 80 ms | < 0.001% |
| **Order Confirmation** | `POST /orders/:id/confirm` (stock reservation) | $\le$ 35 ms | $\le$ 90 ms | $\le$ 180 ms | < 0.05% |
| **Offline Sync Flush** | `POST /sync/batch` (idempotent outbox sync) | $\le$ 50 ms | $\le$ 150 ms | $\le$ 300 ms | < 0.01% |
| **Carrier Webhook Ingest** | `POST /webhooks/carrier` (raw event logging) | $\le$ 20 ms | $\le$ 60 ms | $\le$ 120 ms | < 0.01% |
| **Dashboard Analytics** | `GET /reports/dashboard-kpis` | $\le$ 70 ms | $\le$ 200 ms | $\le$ 400 ms | < 0.1% |
| **Data Export Streaming** | `POST /exports/run` (bounded row streaming) | $\le$ 150 ms | $\le$ 450 ms | $\le$ 900 ms | < 0.05% |

---

## 3. Stress & Scalability Tiers
All services are benchmarked against 4 progressive stress profiles:
1. **Tier 1 (Baseline)**: Normal daily operational load (1x).
2. **Tier 2 (Peak Retail)**: Weekend & evening shopping peaks (2x baseline).
3. **Tier 3 (Campaign Rush)**: National promotions & holiday sales (5x baseline).
4. **Tier 4 (Chaos Spike)**: Extreme traffic surge with concurrent background sync (10x baseline).

**Safety Assertion**: Under Tier 4 10x traffic spikes, resource utilization remains strictly bounded; API rate limiting engages cleanly with HTTP 429 and `Retry-After` headers, preventing process crashes or out-of-memory (OOM) failures.
