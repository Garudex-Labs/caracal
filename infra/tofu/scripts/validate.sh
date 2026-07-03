#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# OpenTofu validation harness: formatting plus offline validate of every
# environment root. Providers are resolved once per root with no backend so
# the harness never touches state or a cluster.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v tofu >/dev/null 2>&1 || { echo "opentofu (tofu) is required" >&2; exit 1; }

tofu fmt -check -recursive "${ROOT}"

for env in "${ROOT}"/envs/*/; do
    echo "==> Validating ${env}"
    tofu -chdir="${env}" init -backend=false -input=false >/dev/null
    tofu -chdir="${env}" validate
done

echo "tofu validation passed"
