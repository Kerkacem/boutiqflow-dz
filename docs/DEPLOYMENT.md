# BoutiqFlow DZ — Production Deployment & Disaster Recovery Runbook

**Target Infrastructure:** VPS / Dedicated Server (Ubuntu 22.04 LTS / Debian 12)  
**Containerization:** Docker Compose  
**Reverse Proxy & Edge TLS:** Caddy Server (Automated HTTPS)  
**Database:** PostgreSQL 15+ with Automated Encrypted Backups

---

## 1. Production Topology

```
             Internet (HTTPS :443 / HTTP :80)
                           │
                           ▼
             +───────────────────────────+
             |       Caddy Reverse       |
             |       Proxy & Edge TLS    |
             |  (Security Headers, HSTS, |
             |   CSP, Rate Limiting)     |
             +───────────────────────────+
                           │
                 Docker Network: boutiqflow-net
                           │
          ┌────────────────┴────────────────┐
          ▼                                 ▼
+───────────────────+             +───────────────────+
|   BoutiqFlow DZ   |             |   PostgreSQL 15   |
|   App Container   | ──────────> | Database Container |
| (Next.js Node 18) |  (Pool :5432)|   (Persistent Vol)|
+───────────────────+             +───────────────────+
                                            │
                                            ▼
                                  +───────────────────+
                                  | Automated Backup  |
                                  | Engine (AES-256)  |
                                  +───────────────────+
```

---

## 2. Quick-Start Deployment Instructions

### Prerequisites:
- A Linux VPS with Docker and Docker Compose installed.
- Domain name pointing to the VPS IP (e.g. `app.boutiqflow.dz`).

### Step 1: Clone Repository & Configure Environment
```bash
git clone https://github.com/boutiqflow/boutiqflow-dz.git /opt/boutiqflow
cd /opt/boutiqflow
cp .env.example .env
# Edit .env with strong production secrets:
nano .env
```

### Step 2: Validate Environment Secrets
Ensure the following variables are securely generated in `.env`:
- `SESSION_SECRET`: 64-character hex string.
- `DATABASE_URL`: `postgresql://boutiqflow:STRONG_PASSWORD@postgres:5432/boutiqflow_prod`
- `BACKUP_ENCRYPTION_KEY`: 32-byte hex key for backup encryption.
- `DOMAIN`: `app.boutiqflow.dz`

### Step 3: Launch Containers
```bash
docker compose up -d --build
```

### Step 4: Run Database Migrations
```bash
docker compose exec app node scripts/migrate.js
```

### Step 5: Verify System Health
```bash
curl -f https://app.boutiqflow.dz/api/health
# Expected Output: {"status":"healthy","database":"connected","version":"1.0.0"}
```

---

## 3. Disaster Recovery & Backup Procedure (`UAT-15`)

### 3.1 Automated Daily Backups
The backup script runs daily via cron, dumping the database, applying gzip compression, and encrypting with AES-256-GCM:
```bash
# Executed by automated job:
docker compose exec app node src/ops/backup.js --action=backup
```
Backups are archived into `/var/backups/boutiqflow/` with timestamped filenames:
`boutiqflow_backup_YYYY-MM-DD_HHMMSS.sql.enc`.

### 3.2 Restore Drill
In the event of total server loss or disaster recovery testing:
1. Provision a fresh PostgreSQL container.
2. Decrypt and restore the backup archive:
   ```bash
   node src/ops/backup.js --action=restore --file=/path/to/backup.sql.enc
   ```
3. Run post-restore verification:
   ```bash
   bash scripts/verify.sh
   ```
*Verification status:* The complete backup, database wipe, decrypt, restore, and ledger invariant verification flow has been verified in `tests/security_attack_p8.test.js`.

---

## 4. Observability & Monitoring
- **Health Check Endpoint:** `GET /api/health` monitors database connectivity, disk space, and pending sync outbox volume.
- **Structured JSON Logs:** All application logs output machine-readable JSON containing timestamp, severity, tenant context, and request IDs without exposing customer PII or credentials.
- **Log Rotation:** Docker log driver configured with `max-size: "50m"` and `max-file: "5"`.
