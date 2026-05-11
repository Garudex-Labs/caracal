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
    out=$(cli XGROUP CREATE "${stream}" "${group}" '$' MKSTREAM 2>&1) || true
    case "${out}" in
        ''|*BUSYGROUP*|*OK*) return 0 ;;
        *) echo "error: XGROUP CREATE ${stream} ${group} failed: ${out}" >&2; exit 1 ;;
    esac
}

# checkMaxLen warns when an existing stream's length exceeds the intended retention
# bound. Provisioning never silently rewrites a stream that was created with a wrong
# policy; operators must drop and recreate explicitly.
checkMaxLen() {
    stream="$1"
    intended="$2"
    info=$(cli XINFO STREAM "${stream}" 2>/dev/null) || return 0
    actual=$(printf '%s\n' "${info}" | awk '/^length$/{getline; print; exit}')
    if [ -n "${actual}" ] && [ "${actual}" -gt "${intended}" ]; then
        echo "warn: ${stream} length ${actual} exceeds intended bound ${intended}" >&2
    fi
}

ensureGroup caracal.audit.events       audit-ingestor
ensureGroup caracal.audit.events       siem-export
ensureGroup caracal.audit.events.dlq   audit-dlq-observer
ensureGroup caracal.policy.invalidate  opa-engine
ensureGroup caracal.sessions.revoke    sts-revocation
ensureGroup caracal.keys.invalidate    sts-keys
ensureGroup caracal.agents.lifecycle       coordinator-relay
ensureGroup caracal.invocations.lifecycle  invocations-observer
ensureGroup caracal.delegations.invalidate delegations-observer

checkMaxLen caracal.audit.events       1000000
checkMaxLen caracal.audit.events.dlq   100000
checkMaxLen caracal.policy.invalidate  10000
checkMaxLen caracal.sessions.revoke    10000
checkMaxLen caracal.keys.invalidate    10000

cli XADD caracal.providers.ratelimit MAXLEN '~' 1 '*' init 1 >/dev/null

echo "redis streams provisioned"
