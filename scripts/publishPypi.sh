#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Publishes selected caracalai-* packages from a local machine to PyPI (default) or TestPyPI (--testpypi), prompting for the API token and skipping versions already on the registry.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/style.sh
. "scripts/lib/style.sh"
# shellcheck source=lib/select.sh
. "scripts/lib/select.sh"

repo="pypi"
host="pypi.org"
for arg in "$@"; do
    case "$arg" in
        --testpypi) repo="testpypi"; host="test.pypi.org" ;;
        -h|--help)
            cat <<EOF
Usage: scripts/publishPypi.sh [--testpypi]

  --testpypi   Upload to TestPyPI (https://test.pypi.org) instead of PyPI.
EOF
            exit 0
            ;;
        *) say_error "publishPypi: unknown arg: $arg"; exit 2 ;;
    esac
done

packages=(
    packages/core/python
    packages/identity/python
    packages/revocation/python
    packages/sdk/python
    packages/transport/mcp/python
    packages/connectors/fastmcp/python
    packages/connectors/redis/python
)

pickItems "${packages[@]}"
if [[ ${#PICKED[@]} -eq 0 ]]; then
    say_warn "publishPypi: no packages selected; nothing to do"
    exit 0
fi
packages=("${PICKED[@]}")
say_info "publishPypi: ${#packages[@]} package(s) selected"

if [[ -z "${PYPI_API_TOKEN:-}" ]]; then
    read -r -s -p "$(printf '%s%s API token (pypi-...):%s ' "${C_PROMPT}" "${repo}" "${C_RESET}")" PYPI_API_TOKEN
    echo
fi
if [[ -z "$PYPI_API_TOKEN" ]]; then
    say_error "publishPypi: PYPI_API_TOKEN is required"
    exit 1
fi

venv="$(mktemp -d)"
cleanup() {
    rm -rf "$venv"
    unset PYPI_API_TOKEN TWINE_USERNAME TWINE_PASSWORD
}
trap cleanup EXIT

python3 -m venv "$venv"
"$venv/bin/python" -m pip install --quiet --require-hashes --requirement scripts/publishPypiRequirements.lock

export TWINE_USERNAME="__token__"
export TWINE_PASSWORD="$PYPI_API_TOKEN"

delay="${PYPI_UPLOAD_DELAY:-30}"

say_header "publishPypi: uploading to ${repo}"
for d in "${packages[@]}"; do
    name="$(awk -F'"' '/^name = /{print $2; exit}' "$d/pyproject.toml")"
    ver="$(awk -F'"' '/^version = /{print $2; exit}' "$d/pyproject.toml")"

    if [[ "$ver" == *"+dev."* || "$ver" == *"-dev."* || "$ver" == *"-rc.sha"* || "$ver" == *"rc0+sha"* ]]; then
        say_error "refusing to publish dev/prerelease version: ${name}==${ver}"
        exit 1
    fi

    if curl -fsSL -o /dev/null "https://${host}/pypi/${name}/${ver}/json"; then
        say_warn "skip ${name}==${ver} (already on ${repo})"
        continue
    fi

    say_step "building $d"
    rm -rf "$d/dist" "$d/build" "$d"/*.egg-info
    ( cd "$d" && "$venv/bin/python" -m build )

    say_step "checking $d artifacts"
    "$venv/bin/twine" check "$d"/dist/*

    say_step "uploading ${name}==${ver} to ${repo}"
    "$venv/bin/twine" upload --skip-existing --repository "${repo}" "$d"/dist/*
    say_success "${name}==${ver}"

    rm -rf "$d/dist" "$d/build" "$d"/*.egg-info

    say_label "sleeping ${delay}s before next upload"
    sleep "$delay"
done

say_step "publishPypi: verifying latest versions on ${repo}"
for d in "${packages[@]}"; do
    name="$(awk -F'"' '/^name = /{print $2; exit}' "$d/pyproject.toml")"
    latest="$(curl -fsSL "https://${host}/pypi/${name}/json" | "$venv/bin/python" -c 'import json,sys; print(json.load(sys.stdin)["info"]["version"])' 2>/dev/null || echo "unknown")"
    printf '  %s%s%s  latest=%s\n' "${C_LABEL}" "${name}" "${C_RESET}" "${latest}"
done

say_success "publishPypi: done"
