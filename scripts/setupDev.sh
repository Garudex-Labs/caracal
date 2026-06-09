#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Installs the local developer toolchain dependencies used by tests and style checks.

set -euo pipefail

cd "$(dirname "$0")/.."

python_cmd="${PYTHON:-python}"
venv_dir="${CARACAL_DEV_VENV:-.venv}"

pnpm install --frozen-lockfile
go mod download

"$python_cmd" -m venv "$venv_dir"
venv_python="$venv_dir/bin/python"
"$venv_python" -m pip install --require-hashes --requirement scripts/pythonTestRequirements.lock
"$venv_python" -m pip install --requirement scripts/pythonStyleRequirements.in
"$venv_python" -m pip install \
  -e packages/core/python \
  -e packages/oauth/python \
  -e packages/identity/python \
  -e packages/revocation/python \
  -e packages/sdk/python \
  -e packages/transport/mcp/python \
  -e packages/connectors/fastmcp/python \
  -e packages/connectors/redis/python

echo "Developer environment ready. Activate Python with: . ${venv_dir}/bin/activate"
