#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Orchestrates the post-release validation harness against the release manifest and renders the markdown findings report.

set -euo pipefail

# shellcheck source=lib/style.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/style.sh"

RELEASE=""
CATEGORY="all"
REPORT_OUT=""
ONLY=""
DRY=0

usage() {
  cat <<EOF
Usage: $0 --release vYYYY.MM.DD [--category <list>] [--report-out <path>] [--only <list>] [--dry-run]

Categories: registryMetadata, pypiInstall, npmInstall, shellBinaries, terminalBinaries,
            installers, containers, provenance, examples, all
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) RELEASE="$2"; shift 2 ;;
    --category) CATEGORY="$2"; shift 2 ;;
    --report-out) REPORT_OUT="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) say_error "unknown arg: $1"; usage; exit 2 ;;
  esac
done

[[ -z "$RELEASE" ]] && { usage; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUB="$ROOT/scripts/postRelease"
MANIFEST="$ROOT/releases/$RELEASE/manifest.json"
FINDINGS_DIR="${FINDINGS_DIR:-$(mktemp -d)}"
REPORT_OUT="${REPORT_OUT:-$ROOT/releases/$RELEASE/validation.md}"

if [[ ! -f "$MANIFEST" ]]; then
  say_error "manifest not found: $MANIFEST"
  exit 2
fi

export CARACAL_RELEASE="$RELEASE"
export FINDINGS_DIR
export ONLY
export DRY_RUN="$DRY"
export MANIFEST

declare -a CATS
if [[ "$CATEGORY" == "all" ]]; then
  CATS=(registryMetadata pypiInstall npmInstall shellBinaries terminalBinaries installers containers provenance examples)
else
  IFS=',' read -r -a CATS <<< "$CATEGORY"
fi

say_header "post-release validation — $RELEASE"
for c in "${CATS[@]}"; do
  script="$SUB/validate$(tr '[:lower:]' '[:upper:]' <<< "${c:0:1}")${c:1}.sh"
  if [[ ! -x "$script" ]]; then
    say_error "missing or non-executable: $script"
    exit 2
  fi
  say_step "$c"
  if "$script"; then
    say_success "$c"
  else
    say_warn "$c reported failures; continuing"
  fi
done

REPORT_OUT="$REPORT_OUT" FINDINGS_DIR="$FINDINGS_DIR" CARACAL_RELEASE="$RELEASE" MANIFEST="$MANIFEST" \
  bun "$SUB/aggregateReport.ts"
