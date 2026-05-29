#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Verifies postgres: migration round-trip, role grants, append-only audit.
# Usage: DATABASE_URL=postgres://... bash verify.sh

set -euo pipefail

DB="${DATABASE_URL:?DATABASE_URL required}"

run_as() { psql "$1" -v ON_ERROR_STOP=1 -c "$2" 2>&1; }
scalar() { psql "$DB" -v ON_ERROR_STOP=1 -tAX -c "$1" 2>&1; }

echo "=== Migration: all expected tables exist ==="
TABLES=(
  admin_audit_events
  admin_tokens
  agent_invocations
  agent_services
  agent_sessions
  agent_topology
  applications
  audit_events
  audit_events_default
  audit_export_watermark
  audit_ingest_alerts
  caracal_outbox
  delegated_grants
  delegation_edges
  delegation_graph_epochs
  event_outbox
  gateway_binding_revision
  gateway_resource_bindings
  invitations
  policies
  policy_set_bindings
  policy_set_versions
  policy_sets
  policy_versions
  providers
  resources
  secrets
  sessions
  step_up_challenges
  teams
  zones
)
for t in "${TABLES[@]}"; do
  if [ "$(scalar "SELECT to_regclass('public.$t') IS NOT NULL;")" != "t" ]; then
    echo "  FAIL: $t missing"
    exit 1
  fi
  echo "  $t OK"
done

echo ""
echo "=== Append-only: audit role cannot UPDATE or DELETE audit_events ==="
AUDIT_URL="${AUDIT_DATABASE_URL:?AUDIT_DATABASE_URL required for audit role permission checks}"
if run_as "$AUDIT_URL" "UPDATE audit_events SET decision='x' WHERE false;" >/dev/null; then
  echo "  FAIL: UPDATE allowed under audit role"
  exit 1
fi
echo "  UPDATE denied OK"
if run_as "$AUDIT_URL" "DELETE FROM audit_events WHERE false;" >/dev/null; then
  echo "  FAIL: DELETE allowed under audit role"
  exit 1
fi
echo "  DELETE denied OK"

echo ""
echo "=== Policy versions immutable: trigger installed ==="
if [ "$(scalar "SELECT count(*) FROM pg_trigger WHERE tgname = 'policy_versions_immutable' AND NOT tgisinternal;")" = "1" ]; then
  echo "  trigger OK"
else
  echo "  FAIL: policy_versions immutability trigger missing"
  exit 1
fi

echo ""
echo "=== RLS: zone-scoped tables are fail-closed ==="
RLS_TABLES=(
  providers
  applications
  sessions
  secrets
  delegated_grants
  policies
  policy_sets
  policy_set_bindings
  resources
  audit_events
  agent_sessions
  invitations
  teams
  delegation_edges
  agent_services
  agent_invocations
  gateway_resource_bindings
  step_up_challenges
  admin_audit_events
  admin_tokens
  delegation_graph_epochs
)
for t in "${RLS_TABLES[@]}"; do
  if [ "$(scalar "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.$t'::regclass;")" != "t" ]; then
    echo "  FAIL: $t RLS disabled"
    exit 1
  fi
  if [ "$(scalar "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = '$t' AND policyname = 'zone_isolation';")" != "1" ]; then
    echo "  FAIL: $t zone_isolation policy missing"
    exit 1
  fi
  echo "  $t OK"
done

echo ""
echo "=== Audit partitions: current rolling window exists ==="
if [ "$(scalar "WITH expected AS (
  SELECT format('audit_events_y%sm%s',
                to_char(date_trunc('month', now()) + (n || ' months')::interval, 'YYYY'),
                to_char(date_trunc('month', now()) + (n || ' months')::interval, 'MM')) AS rel
  FROM generate_series(0, 3) AS n
)
SELECT count(*) FROM expected WHERE to_regclass('public.' || rel) IS NOT NULL;")" != "4" ]; then
  echo "  FAIL: audit partition rolling window incomplete"
  exit 1
fi
echo "  rolling window OK"

echo ""
echo "=== PASS ==="
