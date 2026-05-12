#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Publishes selected caracalai-* packages from a local machine to PyPI (default) or TestPyPI (--testpypi), prompting for the API token and skipping versions already on the registry.

set -euo pipefail

cd "$(dirname "$0")/.."

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
        *) echo "publishPypi: unknown arg: $arg" >&2; exit 2 ;;
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

pickItems() {
    local items=("$@")
    local n=${#items[@]}
    local cursor=0 i
    local selected=()
    for ((i = 0; i < n; i++)); do selected[i]=0; done

    printf '\nUse Up/Down to move, Space to toggle, "a" to toggle all, Enter to confirm, Esc to cancel.\n\n' >&2
    tput civis 2>/dev/null || true
    stty -echo

    render() {
        for ((i = 0; i < n; i++)); do
            local mark=' '
            [[ ${selected[i]} -eq 1 ]] && mark='x'
            local pre='  '
            [[ $i -eq $cursor ]] && pre='> '
            printf '\r%s[%s] %s\033[K\n' "$pre" "$mark" "${items[i]}" >&2
        done
    }
    render

    while true; do
        local key='' rest=''
        if ! IFS= read -rsn1 key; then continue; fi
        if [[ $key == $'\x1b' ]]; then
            IFS= read -rsn2 -t 0.5 rest || rest=''
            key="$key$rest"
        fi
        case "$key" in
            $'\x1b[A') cursor=$(( (cursor - 1 + n) % n )) ;;
            $'\x1b[B') cursor=$(( (cursor + 1) % n )) ;;
            ' ') selected[cursor]=$((1 - selected[cursor])) ;;
            a|A)
                local any=0
                for ((i = 0; i < n; i++)); do [[ ${selected[i]} -eq 0 ]] && any=1; done
                for ((i = 0; i < n; i++)); do selected[i]=$any; done
                ;;
            '') break ;;
            $'\x1b') for ((i = 0; i < n; i++)); do selected[i]=0; done; break ;;
            *) continue ;;
        esac
        printf '\033[%dA' "$n" >&2
        render
    done

    stty echo
    tput cnorm 2>/dev/null || true

    PICKED=()
    for ((i = 0; i < n; i++)); do
        [[ ${selected[i]} -eq 1 ]] && PICKED+=("${items[i]}")
    done
    return 0
}

pickItems "${packages[@]}"
if [[ ${#PICKED[@]} -eq 0 ]]; then
    echo "publishPypi: no packages selected; nothing to do"
    exit 0
fi
packages=("${PICKED[@]}")
echo "publishPypi: ${#packages[@]} package(s) selected"

if [[ -z "${PYPI_API_TOKEN:-}" ]]; then
    read -r -s -p "${repo} API token (pypi-...): " PYPI_API_TOKEN
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

delay="${PYPI_UPLOAD_DELAY:-30}"

for d in "${packages[@]}"; do
    name="$(awk -F'"' '/^name = /{print $2; exit}' "$d/pyproject.toml")"
    ver="$(awk -F'"' '/^version = /{print $2; exit}' "$d/pyproject.toml")"

    if curl -fsSL -o /dev/null "https://${host}/pypi/${name}/${ver}/json"; then
        echo "publishPypi: skip ${name}==${ver} (already on ${repo})"
        continue
    fi

    echo "publishPypi: building $d"
    rm -rf "$d/dist" "$d/build" "$d"/*.egg-info
    ( cd "$d" && "$venv/bin/python" -m build )

    echo "publishPypi: checking $d artifacts"
    "$venv/bin/twine" check "$d"/dist/*

    echo "publishPypi: uploading ${name}==${ver} to ${repo}"
    "$venv/bin/twine" upload --skip-existing --repository "${repo}" "$d"/dist/*

    rm -rf "$d/dist" "$d/build" "$d"/*.egg-info

    echo "publishPypi: sleeping ${delay}s before next upload"
    sleep "$delay"
done

echo "publishPypi: verifying latest versions on ${repo}"
for d in "${packages[@]}"; do
    name="$(awk -F'"' '/^name = /{print $2; exit}' "$d/pyproject.toml")"
    latest="$(curl -fsSL "https://${host}/pypi/${name}/json" | "$venv/bin/python" -c 'import json,sys; print(json.load(sys.stdin)["info"]["version"])' 2>/dev/null || echo "unknown")"
    echo "publishPypi: ${name} latest=${latest}"
done

echo "publishPypi: done"
