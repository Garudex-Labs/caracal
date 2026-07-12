#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Publishes selected npm and PyPI packages from the central release plan.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/style.sh
. "scripts/lib/style.sh"
# shellcheck source=lib/select.sh
. "scripts/lib/select.sh"

ecosystem="all"
repo="pypi"
host="pypi.org"
select=0
venv=""
python_cmd=""

cleanup() {
    [[ -n "${venv:-}" ]] && rm -rf "$venv"
    unset PYPI_API_TOKEN TWINE_USERNAME TWINE_PASSWORD
}
trap cleanup EXIT

usage() {
    cat <<EOF
Usage: scripts/publishPackages.sh [options]

  --ecosystem npm|pypi|all  Target ecosystem. Default: all.
  --testpypi                Use TestPyPI.
  --select                  Pick from the plan.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ecosystem)
            [[ $# -ge 2 ]] || { say_error "--ecosystem needs npm, pypi, or all"; exit 2; }
            ecosystem="$2"
            [[ "$ecosystem" == "npm" || "$ecosystem" == "pypi" || "$ecosystem" == "all" ]] || { say_error "--ecosystem must be npm, pypi, or all"; exit 2; }
            shift 2
            ;;
        --testpypi) repo="testpypi"; host="test.pypi.org"; shift ;;
        --select) select=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) say_error "unknown arg: $1"; usage; exit 2 ;;
    esac
done

if [[ "$repo" == "testpypi" && "$ecosystem" == "npm" ]]; then
    say_error "--testpypi needs --ecosystem pypi or all"
    exit 2
fi

plan="$(node scripts/releasePlan.mjs --ecosystem "$ecosystem" --format json)"
npm_packages=()
while IFS= read -r dir; do
    [[ -n "$dir" ]] && npm_packages+=("$dir")
done < <(node -e "const p=JSON.parse(process.argv[1]); for (const pkg of p.matrix.include.filter((pkg) => pkg.ecosystem === 'npm')) console.log(pkg.dir)" "$plan")
pypi_packages=()
while IFS= read -r dir; do
    [[ -n "$dir" ]] && pypi_packages+=("$dir")
done < <(node -e "const p=JSON.parse(process.argv[1]); for (const pkg of p.matrix.include.filter((pkg) => pkg.ecosystem === 'pypi')) console.log(pkg.dir)" "$plan")

if [[ "$select" == "1" && ${#npm_packages[@]} -gt 0 ]]; then
    pickItems "${npm_packages[@]}"
    npm_packages=(${PICKED[@]+"${PICKED[@]}"})
fi
if [[ "$select" == "1" && ${#pypi_packages[@]} -gt 0 ]]; then
    pickItems "${pypi_packages[@]}"
    pypi_packages=(${PICKED[@]+"${PICKED[@]}"})
fi

if [[ ${#npm_packages[@]} -eq 0 && ${#pypi_packages[@]} -eq 0 ]]; then
    say_warn "No packages selected."
    exit 0
fi

if [[ ${#npm_packages[@]} -gt 0 ]]; then
    say_error "Local npm publication is disabled; publish through release.yml."
    exit 1
fi

if [[ "$repo" == "pypi" && ${#pypi_packages[@]} -gt 0 ]]; then
    say_error "Local production PyPI publication is disabled; publish through release.yml."
    exit 1
fi

pyField() {
    awk -v key="$2" -F'"' '$0 ~ "^" key " = " {print $2; exit}' "$1/pyproject.toml"
}

pythonCmd() {
    if [[ -n "$python_cmd" ]]; then
        printf '%s' "$python_cmd"
        return 0
    fi
    if command -v python3 >/dev/null 2>&1; then
        python_cmd="python3"
    elif command -v python >/dev/null 2>&1; then
        python_cmd="python"
    else
        say_error "Python is required."
        exit 2
    fi
    printf '%s' "$python_cmd"
}

venvPython() {
    if [[ -x "$venv/Scripts/python.exe" ]]; then
        printf '%s' "$venv/Scripts/python.exe"
    else
        printf '%s' "$venv/bin/python"
    fi
}

publishPypi() {
    [[ ${#pypi_packages[@]} -gt 0 ]] || return 0
    say_info "PyPI packages: ${#pypi_packages[@]}"
    if [[ -z "${PYPI_API_TOKEN:-}" ]]; then
        read -r -s -p "$(printf '%s%s token:%s ' "${C_PROMPT}" "${repo}" "${C_RESET}")" PYPI_API_TOKEN
        echo
    fi
    if [[ -z "$PYPI_API_TOKEN" ]]; then
        say_error "PYPI_API_TOKEN is required."
        exit 1
    fi
    venv="$(mktemp -d)"
    "$(pythonCmd)" -m venv "$venv"
    pypi_python="$(venvPython)"
    "$pypi_python" -m pip install --quiet --require-hashes --requirement scripts/publishPypiRequirements.lock
    export TWINE_USERNAME="__token__"
    export TWINE_PASSWORD="$PYPI_API_TOKEN"
    delay="${PYPI_UPLOAD_DELAY:-30}"
    say_header "Publishing ${repo}"
    for d in "${pypi_packages[@]}"; do
        name="$(pyField "$d" name)"
        ver="$(pyField "$d" version)"
        if [[ "$ver" == *"dev.sha"* || "$ver" == *"dev."* ]]; then
            say_error "Dev version blocked: ${name}==${ver}"
            exit 1
        fi
        if curl -fsSL -o /dev/null "https://${host}/pypi/${name}/${ver}/json"; then
            say_error "Already published: ${name}==${ver}"
            exit 1
        fi
        say_step "Build $d"
        rm -rf "$d/dist" "$d/build" "$d"/*.egg-info
        ( cd "$d" && "$pypi_python" -m build )
        say_step "Check $d"
        "$pypi_python" -m twine check "$d"/dist/*
        say_step "${name}==${ver} -> ${repo}"
        "$pypi_python" -m twine upload --repository "${repo}" "$d"/dist/*
        say_success "${name}==${ver}"
        rm -rf "$d/dist" "$d/build" "$d"/*.egg-info
        say_label "Wait ${delay}s"
        sleep "$delay"
    done
    rm -rf "$venv"
    venv=""
    unset PYPI_API_TOKEN TWINE_USERNAME TWINE_PASSWORD
}

publishPypi
say_success "Publish complete."
