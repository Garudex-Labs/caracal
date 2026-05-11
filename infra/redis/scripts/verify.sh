#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Verifies redis: all streams and consumer groups exist; provisioner idempotency.
# Usage: REDIS_HOST=localhost REDIS_PORT=6379 REDIS_PASSWORD=secret bash verify.sh

set -euo pipefail

HOST="${REDIS_HOST:-localhost}"
PORT="${REDIS_PORT:-6379}"
PASS="${REDIS_PASSWORD:?REDIS_PASSWORD required}"

cli() { redis-cli -h "$HOST" -p "$PORT" -a "$PASS" --no-auth-warning "$@"; }

STREAMS=(
  "caracal.audit.events"
  "caracal.policy.invalidate"
  "caracal.sessions.revoke"
  "caracal.agents.lifecycle"
  "caracal.providers.ratelimit"
)
EXPECTED_GROUPS=(
  "caracal.audit.events:audit-ingestor"
  "caracal.audit.events:siem-export"
  "caracal.policy.invalidate:opa-engine"
  "caracal.sessions.revoke:sts-revocation"
  "caracal.agents.lifecycle:coordinator-relay"
)

echo "=== Streams exist ==="
for s in "${STREAMS[@]}"; do
  TYPE=$(cli TYPE "$s")
  if [ "$TYPE" = "stream" ]; then
    echo "  $s OK"
  else
    echo "  FAIL: $s type=$TYPE (expected stream)"
    exit 1
  fi
done

echo ""
echo "=== Consumer groups exist ==="
for entry in "${EXPECTED_GROUPS[@]}"; do
  STREAM="${entry%%:*}"
  GROUP="${entry##*:}"
  FOUND=$(cli XINFO GROUPS "$STREAM" | grep -c "$GROUP" || true)
  if [ "$FOUND" -ge 1 ]; then
    echo "  $STREAM/$GROUP OK"
  else
    echo "  FAIL: $STREAM/$GROUP not found"
    exit 1
  fi
done

echo ""
echo "=== Idempotency: re-run provisioner ==="
bash "$(dirname "$0")/../provision-streams.sh"
echo "  Re-run completed without error"

echo ""
echo "=== PASS ==="
