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
helm template caracal "${ROOT}" -f "${ROOT}/values.production.yaml" >/tmp/caracal-helm-production.yaml

if helm template caracal "${ROOT}" -f "${ROOT}/values.production.yaml" --set secrets.create=true >/tmp/caracal-helm-secret-negative.yaml 2>/tmp/caracal-helm-secret-negative.err; then
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

echo "helm chart validation passed"
