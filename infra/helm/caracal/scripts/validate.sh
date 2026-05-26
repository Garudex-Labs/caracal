#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Helm validation harness for Caracal chart render profiles and guardrails.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v helm >/dev/null 2>&1 || { echo "helm is required" >&2; exit 1; }

helm lint "${ROOT}"
helm template caracal "${ROOT}" -f "${ROOT}/values.dev.yaml" >/tmp/caracal-helm-dev.yaml
helm template caracal "${ROOT}" -f "${ROOT}/values.rc.yaml" >/tmp/caracal-helm-rc.yaml
prod_set=(
    --set secrets.database.host=postgres-ha.caracal-platform.svc.cluster.local
    --set secrets.redis.host=redis-ha.caracal-platform.svc.cluster.local
)
helm template caracal "${ROOT}" -f "${ROOT}/values.production.yaml" "${prod_set[@]}" >/tmp/caracal-helm-production.yaml

if helm template caracal "${ROOT}" -f "${ROOT}/values.production.yaml" >/tmp/caracal-helm-production-negative.yaml 2>/tmp/caracal-helm-production-negative.err; then
    echo "stable render with default Postgres/Redis hosts must fail" >&2
    exit 1
fi
grep -q "externally managed HA Postgres" /tmp/caracal-helm-production-negative.err

if helm template caracal "${ROOT}" -f "${ROOT}/values.production.yaml" --set secrets.database.host=postgres-ha.caracal-platform.svc.cluster.local >/tmp/caracal-helm-production-redis-negative.yaml 2>/tmp/caracal-helm-production-redis-negative.err; then
    echo "stable render with default Redis host must fail" >&2
    exit 1
fi
grep -q "externally managed HA Redis" /tmp/caracal-helm-production-redis-negative.err

if helm template caracal "${ROOT}" -f "${ROOT}/values.production.yaml" "${prod_set[@]}" --set secrets.create=true >/tmp/caracal-helm-secret-negative.yaml 2>/tmp/caracal-helm-secret-negative.err; then
    echo "stable render with secrets.create=true must fail" >&2
    exit 1
fi
grep -q "secrets.create=true is forbidden when global.mode=stable" /tmp/caracal-helm-secret-negative.err

if helm template caracal "${ROOT}" -f "${ROOT}/values.rc.yaml" --set secrets.create=true >/tmp/caracal-helm-rc-secret-negative.yaml 2>/tmp/caracal-helm-rc-secret-negative.err; then
    echo "rc render with plaintext secrets must require evaluation mode" >&2
    exit 1
fi
grep -q "global.evaluation=true" /tmp/caracal-helm-rc-secret-negative.err

if grep -A8 -E 'port: 53' /tmp/caracal-helm-production.yaml; then
    echo "production profile must not render open DNS egress" >&2
    exit 1
fi

if awk '
    /^kind: NetworkPolicy$/ { in_policy = 1; next }
    in_policy && /^---$/ { in_policy = 0 }
    in_policy && /port: 8081/ { found = 1 }
    END { exit found ? 0 : 1 }
' /tmp/caracal-helm-production.yaml; then
    echo "production profile must not render broad Gateway ingress" >&2
    exit 1
fi

echo "helm chart validation passed"
