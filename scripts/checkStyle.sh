#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Checks changed primary-language source files against the project style gates.

set -euo pipefail

cd "$(dirname "$0")/.."

check_all=false
fix=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) check_all=true ;;
    --fix) fix=true ;;
    -h|--help)
      cat <<EOF
Usage: scripts/checkStyle.sh [--all] [--fix]
  no flags : check files changed from STYLE_BASE_REF or HEAD
  --all    : check all tracked primary-language source files
  --fix    : rewrite checked files with their language formatter
EOF
      exit 0
      ;;
    *) echo "Unknown style option: $1" >&2; exit 2 ;;
  esac
  shift
done

mapfile -t files < <(
  if $check_all; then
    git ls-files
  elif [[ -n "${STYLE_BASE_REF:-}" ]]; then
    git diff --name-only --diff-filter=ACMRT "${STYLE_BASE_REF}...HEAD"
  else
    {
      git diff --name-only --diff-filter=ACMRT HEAD
      git diff --name-only --diff-filter=ACMRT --cached
      git ls-files --others --exclude-standard
    } | sort -u
  fi
)

ts_files=()
go_files=()
py_files=()

for file in "${files[@]}"; do
  [[ -f "$file" ]] || continue
  case "$file" in
    node_modules/*|*/node_modules/*|dist/*|*/dist/*|build/*|*/build/*|coverage/*|*/coverage/*|packages/engine/src/embedded.ts|apps/runtime/src/runtime/version.gen.ts|apps/console/src/version.gen.ts)
      continue
      ;;
  esac
  case "$file" in
    apps/*.ts|apps/*.tsx|apps/*.js|apps/*.mjs|apps/*.cjs|apps/**/*.ts|apps/**/*.tsx|apps/**/*.js|apps/**/*.mjs|apps/**/*.cjs|packages/*.ts|packages/*.tsx|packages/*.js|packages/*.mjs|packages/*.cjs|packages/**/*.ts|packages/**/*.tsx|packages/**/*.js|packages/**/*.mjs|packages/**/*.cjs|tests/typescript/*.ts|tests/typescript/*.tsx|tests/typescript/**/*.ts|tests/typescript/**/*.tsx|scripts/*.ts|scripts/*.js|scripts/*.mjs|scripts/*.cjs|scripts/**/*.ts|scripts/**/*.js|scripts/**/*.mjs|scripts/**/*.cjs|examples/*.js|examples/*.mjs|examples/*.cjs|examples/**/*.js|examples/**/*.mjs|examples/**/*.cjs)
      ts_files+=("$file")
      ;;
  esac
  case "$file" in
    *.go) go_files+=("$file") ;;
  esac
  case "$file" in
    packages/*.py|packages/**/*.py|tests/python/*.py|tests/python/**/*.py|tests/shared/test-utils/python/*.py|tests/shared/test-utils/python/**/*.py|examples/*.py|examples/**/*.py)
      py_files+=("$file")
      ;;
  esac
done

if [[ ${#ts_files[@]} -eq 0 && ${#go_files[@]} -eq 0 && ${#py_files[@]} -eq 0 ]]; then
  echo "No style-checked source files changed."
  exit 0
fi

if [[ ${#ts_files[@]} -gt 0 ]]; then
  if $fix; then
    pnpm exec prettier --write "${ts_files[@]}"
  else
    pnpm exec prettier --check "${ts_files[@]}"
  fi
fi

if [[ ${#go_files[@]} -gt 0 ]]; then
  if $fix; then
    gofmt -w "${go_files[@]}"
  else
    unformatted="$(gofmt -l "${go_files[@]}")"
    if [[ -n "$unformatted" ]]; then
      printf '%s\n' "$unformatted"
      echo "Go files must be formatted with gofmt." >&2
      exit 1
    fi
  fi
fi

if [[ ${#py_files[@]} -gt 0 ]]; then
  if $fix; then
    python -m ruff format "${py_files[@]}"
  else
    python -m ruff format --check "${py_files[@]}"
  fi
fi
