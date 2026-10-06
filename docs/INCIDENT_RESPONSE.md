# BoutiqFlow DZ — Incident Response Plan & Severity Matrix

## 1. Governance & Standards Framework
This Incident Response Plan is structured according to **NIST SP 800-61 Rev. 3** (*Computer Security Incident Handling*) and statutory requirements under Algerian Law No. 18-07 as amended by Law No. 25-11 (Article 45 bis 8 on mandatory authority notification).

---

## 2. Incident Classification & Severity Matrix

| Severity | Definition & Impact Criteria | Target Response (Triage) | Target Containment | Authority Notification Trigger |
|---|---|---|---|---|
| **P0 (Critical)** | Active ransomware or data wiper; cross-tenant data leak; root/superadmin account takeover; complete database corruption; uncontained personal data breach. | **< 15 minutes** | **< 1 hour** | **Mandatory ANPDP notification within 5 days** (Art. 45 bis 8). |
| **P1 (High)** | Single-tenant service outage; payment provider webhook failure affecting settlements; suspected API key theft; partial inventory ledger desync. | **< 30 minutes** | **< 4 hours** | Evaluated by DPO; required if high risk to data subjects. |
| **P2 (Medium)** | Intermittent courier tracking failures; reporting read-model drift; non-exploitable configuration warning; bounded rate-limit spike. | **< 2 hours** | **< 12 hours** | No statutory reporting required unless escalated. |
| **P3 (Low)** | Isolated client sync conflict resolved by manager; non-impacting UI error; documentation or minor telemetry discrepancy. | **< 8 hours** | **< 48 hours** | Internal logging only. |

---

## 3. Incident Lifecycle Workflow (NIST SP 800-61 Rev. 3)

```
[ 1. DETECT ] ──► [ 2. TRIAGE ] ──► [ 3. CONTAIN ] ──► [ 4. ERADICATE ]
                                                              │
[ 7. REVIEW ] ◄── [ 6. VERIFY ] ◄── [ 5. RECOVER ] ◄──────────┘
```

### Phase 1: Detection & Reporting
- Security anomalies detected via automated alerts (failed auth bursts, IDOR attempts, journal hash mismatch, rate-limit spikes).
- Operator or customer support escalates via emergency ticket to the on-call Security Lead.

### Phase 2: Triage & Severity Assignment
- Incident Commander (IC) assesses blast radius: number of affected tenants, presence of PII, financial risk.
- Assign severity (P0, P1, P2, P3). Open designated Incident War Room and secure communication channel.

### Phase 3: Containment
- **Short-Term Containment**:
  - Isolate compromised network routes or API endpoints.
  - Temporarily switch affected tenant to `READ_ONLY` or `SUSPENDED` mode.
  - Revoke active user sessions and compromised API keys.
- **Evidence Preservation**:
  - Capture volatile memory dumps, database transaction snapshots, and unaltered audit logs for forensics.

### Phase 4: Eradication
- Identify and eliminate root vulnerability (patch vulnerable endpoint, remove malicious payload, block abusive IP ranges).
- Re-run security AST and secret scanners to confirm zero remaining threat vectors.

### Phase 5: Recovery
- Restore verified clean state from encrypted, immutable backup archives.
- Re-run migrations and apply validated WAL / processing journal increments up to recovery point.

### Phase 6: Post-Recovery Data Verification
- Execute `IntegrityCheckJob` to confirm zero financial or stock drift.
- Validate cryptographic hash chaining on Processing Journal (`carnet automatisé`).
- Confirm Row-Level Security (RLS) enforcement across all tables.

### Phase 7: Post-Incident Review & Lessons Learned
- Conduct blameless Post-Mortem within 72 hours of incident closure.
- Document root causes, timeline, communication logs, and preventative engineering tasks.
- If personal data was breached, finalize formal ANPDP report within the 5-day statutory window.
