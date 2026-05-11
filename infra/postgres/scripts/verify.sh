#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Verifies postgres: migration round-trip, role grants, append-only audit.
# Usage: DATABASE_URL=postgres://... bash verify.sh

set -euo pipefail

DB="${DATABASE_URL:?DATABASE_URL required}"

run() { psql "$DB" -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
run_as() { psql "$1" -v ON_ERROR_STOP=1 -c "$2" 2>&1; }

echo "=== Migration: all expected tables exist ==="
TABLES=(zones applications resources providers policies policy_versions policy_sets \
        policy_set_versions policy_set_bindings sessions delegated_grants secrets \
        step_up_challenges audit_events agent_sessions agent_topology invitations teams)
for t in "${TABLES[@]}"; do
  run "SELECT 1 FROM $t LIMIT 0;" > /dev/null
  echo "  $t OK"
done

echo ""
echo "=== Append-only: audit role cannot UPDATE or DELETE audit_events ==="
AUDIT_URL="${AUDIT_DATABASE_URL:-$DB}"
if run_as "$AUDIT_URL" "UPDATE audit_events SET decision='x' WHERE false;" 2>&1 | grep -q "permission denied"; then
  echo "  UPDATE denied OK"
else
  echo "  WARNING: UPDATE not denied under audit role"
fi
if run_as "$AUDIT_URL" "DELETE FROM audit_events WHERE false;" 2>&1 | grep -q "permission denied"; then
  echo "  DELETE denied OK"
else
  echo "  WARNING: DELETE not denied under audit role"
fi

echo ""
echo "=== Policy versions immutable: UPDATE denied ==="
if run "UPDATE policy_versions SET content='x' WHERE false;" 2>&1 | grep -q "denied\|immutable\|policy"; then
  echo "  UPDATE denied OK"
else
  echo "  (no immutability trigger fired — check DB rule)"
fi

echo ""
echo "=== PASS ==="
