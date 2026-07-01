#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Helm validation harness for Caracal chart render profiles and guardrails.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v helm >/dev/null 2>&1 || { echo "helm is required" >&2; exit 1; }

DIR="$(mktemp -d)"
trap 'rm -rf "${DIR}"' EXIT

helm lint "${ROOT}"
helm template caracal "${ROOT}" -f "${ROOT}/values.dev.yaml" >"${DIR}/dev.yaml"
helm template caracal "${ROOT}" -f "${ROOT}/values.rc.yaml" >"${DIR}/rc.yaml"
prod_set=(
    --set secrets.database.host=postgres-ha.caracal-platform.svc.cluster.local
    --set secrets.redis.host=redis-ha.caracal-platform.svc.cluster.local
)
helm template caracal "${ROOT}" -f "${ROOT}/values.production.yaml" "${prod_set[@]}" >"${DIR}/production.yaml"

helm template caracal "${ROOT}" -f "${ROOT}/examples/values.cloud-managed.yaml" >"${DIR}/cloud.yaml"
grep -q "kind: Ingress" "${DIR}/cloud.yaml" || { echo "cloud overlay must render ingress" >&2; exit 1; }
grep -q "kind: ServiceMonitor" "${DIR}/cloud.yaml" || { echo "cloud overlay must render ServiceMonitor" >&2; exit 1; }

if helm template caracal "${ROOT}" -f "${ROOT}/values.production.yaml" >"${DIR}/production-negative.yaml" 2>"${DIR}/production-negative.err"; then
    echo "stable render with default Postgres/Redis hosts must fail" >&2
    exit 1
fi
grep -q "externally managed HA Postgres" "${DIR}/production-negative.err"

if helm template caracal "${ROOT}" -f "${ROOT}/values.production.yaml" --set secrets.database.host=postgres-ha.caracal-platform.svc.cluster.local >"${DIR}/production-redis-negative.yaml" 2>"${DIR}/production-redis-negative.err"; then
    echo "stable render with default Redis host must fail" >&2
    exit 1
fi
grep -q "externally managed HA Redis" "${DIR}/production-redis-negative.err"

if helm template caracal "${ROOT}" -f "${ROOT}/values.production.yaml" "${prod_set[@]}" --set secrets.create=true >"${DIR}/secret-negative.yaml" 2>"${DIR}/secret-negative.err"; then
    echo "stable render with secrets.create=true must fail" >&2
    exit 1
fi
grep -q "secrets.create=true is forbidden when global.mode=stable" "${DIR}/secret-negative.err"

if helm template caracal "${ROOT}" -f "${ROOT}/values.rc.yaml" --set secrets.create=true >"${DIR}/rc-secret-negative.yaml" 2>"${DIR}/rc-secret-negative.err"; then
    echo "rc render with plaintext secrets must require evaluation mode" >&2
    exit 1
fi
grep -q "global.evaluation=true" "${DIR}/rc-secret-negative.err"

if grep -A8 -E 'port: 53' "${DIR}/production.yaml"; then
    echo "production profile must not render open DNS egress" >&2
    exit 1
fi

if awk '
    /^kind: NetworkPolicy$/ { in_policy = 1; next }
    in_policy && /^---$/ { in_policy = 0 }
    in_policy && /port: 8081/ { found = 1 }
    END { exit found ? 0 : 1 }
' "${DIR}/production.yaml"; then
    echo "production profile must not render broad Gateway ingress" >&2
    exit 1
fi

echo "helm chart validation passed"
