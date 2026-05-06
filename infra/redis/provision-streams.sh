#!/bin/sh
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Idempotent provisioner for Caracal Redis streams and consumer groups.

set -eu

REDIS_HOST="${REDIS_HOST:-redis}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"

cli() {
    if [ -n "${REDIS_PASSWORD}" ]; then
        redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" -a "${REDIS_PASSWORD}" --no-auth-warning "$@"
    else
        redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" "$@"
    fi
}

ensureGroup() {
    stream="$1"
    group="$2"
    cli XGROUP CREATE "${stream}" "${group}" '$' MKSTREAM 2>&1 \
        | grep -v BUSYGROUP || true
}

ensureGroup caracal.audit.events       audit-ingestor
ensureGroup caracal.audit.events       siem-export
ensureGroup caracal.policy.invalidate  opa-engine
ensureGroup caracal.sessions.revoke    sts-revocation
ensureGroup caracal.agents.lifecycle       agent-coordinator-relay
ensureGroup caracal.invocations.lifecycle  invocations-observer
ensureGroup caracal.delegations.invalidate delegations-observer

cli XADD caracal.providers.ratelimit MAXLEN '~' 1 '*' init 1 >/dev/null

echo "redis streams provisioned"
