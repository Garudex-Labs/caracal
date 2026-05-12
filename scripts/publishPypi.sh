#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Publishes all caracalai-* PyPI packages from a local machine using a manually entered PyPI API token, skipping versions already on the registry.

set -euo pipefail

cd "$(dirname "$0")/.."

packages=(
    packages/core/python
    packages/identity/python
    packages/revocation/python
    packages/sdk/python
    packages/transport/mcp/python
    packages/connectors/fastmcp/python
    packages/connectors/redis/python
)

if [[ -z "${PYPI_API_TOKEN:-}" ]]; then
    read -r -s -p "PyPI API token (pypi-...): " PYPI_API_TOKEN
    echo
fi
if [[ -z "$PYPI_API_TOKEN" ]]; then
    echo "publishPypi: PYPI_API_TOKEN is required" >&2
    exit 1
fi

venv="$(mktemp -d)"
cleanup() {
    rm -rf "$venv"
    unset PYPI_API_TOKEN TWINE_USERNAME TWINE_PASSWORD
}
trap cleanup EXIT

python3 -m venv "$venv"
"$venv/bin/pip" install --quiet build==1.2.2 twine==6.0.1

export TWINE_USERNAME="__token__"
export TWINE_PASSWORD="$PYPI_API_TOKEN"

for d in "${packages[@]}"; do
    echo "publishPypi: building $d"
    rm -rf "$d/dist" "$d/build" "$d"/*.egg-info
    ( cd "$d" && "$venv/bin/python" -m build )

    echo "publishPypi: checking $d artifacts"
    "$venv/bin/twine" check "$d"/dist/*

    echo "publishPypi: uploading $d (skip-existing)"
    "$venv/bin/twine" upload --skip-existing "$d"/dist/*

    rm -rf "$d/dist" "$d/build" "$d"/*.egg-info
done

echo "publishPypi: done"
