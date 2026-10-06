#!/usr/bin/env bash
set -euo pipefail

echo "[SECURITY-SCAN] Starting credential and security vulnerability scan..."

# Check for accidental secrets / private keys committed to tracked files
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SECRET_MATCHES=$(git grep -i -E "BEGIN (RSA|OPENSSH|EC|PGP) PRIVATE KEY|ghp_[A-Za-z0-9]{36}|chargily_secret_key_[a-zA-Z0-9]+" || true)
  if [ -n "$SECRET_MATCHES" ]; then
    echo "[SECURITY ERROR] Detected potential private keys or tokens in git files:"
    echo "$SECRET_MATCHES"
    exit 1
  fi
fi

echo "[SECURITY-SCAN] Checking RLS enforcement in SQL migrations..."
MIGRATION_DIR="migrations"
if [ -d "$MIGRATION_DIR" ]; then
  for sql_file in "$MIGRATION_DIR"/*.sql; do
    if [ -f "$sql_file" ]; then
      # Extract table names correctly handling optional IF NOT EXISTS
      TABLE_CREATES=$(grep -i "CREATE TABLE" "$sql_file" | sed -E 's/CREATE TABLE (IF NOT EXISTS )?//i' | awk '{print $1}' | tr -d '();')
      for tbl in $TABLE_CREATES; do
        if [ "$tbl" = "schema_migrations" ] || [ "$tbl" = "tenants" ]; then
          # Tenants table is the root catalog table
          continue
        fi
        if ! grep -qi "ALTER TABLE $tbl ENABLE ROW LEVEL SECURITY" "$sql_file"; then
          echo "[SECURITY ERROR] Table '$tbl' in $sql_file lacks 'ENABLE ROW LEVEL SECURITY'"
          exit 1
        fi
        if ! grep -qi "ALTER TABLE $tbl FORCE ROW LEVEL SECURITY" "$sql_file"; then
          echo "[SECURITY ERROR] Table '$tbl' in $sql_file lacks 'FORCE ROW LEVEL SECURITY'"
          exit 1
        fi
      done
    fi
  done
fi

echo "[SECURITY-SCAN] Security scan clean. Zero secrets and all RLS policies strictly enforced."
exit 0
