#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Publishes modified caracalai-* packages to PyPI or TestPyPI, allowing rc versions and refusing dev versions.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/style.sh
. "scripts/lib/style.sh"
# shellcheck source=lib/select.sh
. "scripts/lib/select.sh"

repo="pypi"
host="pypi.org"
mode="changed"
base_ref=""
head_ref="HEAD"
select=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --testpypi) repo="testpypi"; host="test.pypi.org"; shift ;;
        --all) mode="all"; shift ;;
        --select) select=1; shift ;;
        --base) [[ $# -ge 2 ]] || { say_error "publishPypi: --base requires a ref"; exit 2; }; base_ref="$2"; shift 2 ;;
        --head) [[ $# -ge 2 ]] || { say_error "publishPypi: --head requires a ref"; exit 2; }; head_ref="$2"; shift 2 ;;
        -h|--help)
            cat <<EOF
Usage: scripts/publishPypi.sh [--testpypi] [--all] [--select] [--base REF] [--head REF]

  --testpypi   Upload to TestPyPI (https://test.pypi.org) instead of PyPI.
  --all        Include every publishable PyPI package.
  --select     Interactively narrow the detected package list.
  --base REF   Diff base ref. Defaults to the latest reachable release tag before --head.
  --head REF   Diff head ref. Defaults to HEAD.
               Use --all for an intentional full-package publish.
EOF
            exit 0
            ;;
        *) say_error "publishPypi: unknown arg: $1"; exit 2 ;;
    esac
done

detect_args=(--ecosystem pypi --format paths --head "$head_ref")
if [[ "$mode" == "all" ]]; then
    detect_args+=(--all)
elif [[ -n "$base_ref" ]]; then
    detect_args+=(--base "$base_ref")
fi

mapfile -t packages < <(node scripts/detectChangedPackages.mjs "${detect_args[@]}")

if [[ ${#packages[@]} -eq 0 ]]; then
    say_warn "publishPypi: no packages selected; nothing to do"
    exit 0
fi

if [[ "$select" == "1" ]]; then
    pickItems "${packages[@]}"
    if [[ ${#PICKED[@]} -eq 0 ]]; then
        say_warn "publishPypi: no packages selected; nothing to do"
        exit 0
    fi
    packages=("${PICKED[@]}")
fi

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

    if [[ "$ver" == *"dev.sha"* || "$ver" == *"dev."* ]]; then
        say_error "refusing to publish dev-stamped version: ${name}==${ver}"
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
