# MAHAL — Operations Runbook

## 1. Local Environment & Verification Commands
- Run verification suite: `bash scripts/verify.sh`
- Local test runner: `node tests/run_tests.js` (or via bun/pnpm-shim)
- Environment checks: `node scripts/check-env.js`

## 2. PostgreSQL Configuration & Migrations
- Migration runner: applies incremental SQL scripts in `migrations/` strictly in order.
- RLS Verification: verifies all tenant tables have `FORCE ROW LEVEL SECURITY`.
- Session setup: all application queries must set `SET LOCAL app.tenant_id = ?`.

## 3. Backup & Disaster Recovery Procedure
- Automated backup command: `pg_dump -Fc --clean mahal_prod > backup.dump`
- Restore drill:
  1. `dropdb mahal_restore_test`
  2. `createdb mahal_restore_test`
  3. `pg_restore -d mahal_restore_test backup.dump`
  4. Run invariant tests (`INV-1` through `INV-7`) against restored database.

## 4. Production Deployment Gate
- Production deploys are strictly human-gated.
- Prerequisites: Green CI build, zero high/critical vulnerabilities, `docs/RELEASE_READINESS.md` signed off.
