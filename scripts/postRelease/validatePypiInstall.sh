#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Installs every PyPI package at its manifest-pinned version across pip, uv, and poetry.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "$HERE/lib/common.sh"

readonly AREA="pypiInstall"
readonly PM="${PM:-pip}"
readonly PY="${PY:-3.12}"

IMPORT_PKGS=(
  caracalai-core
  caracalai-identity
  caracalai-revocation
  caracalai-sdk
  caracalai-transport-mcp
  caracalai-mcp-fastmcp
  caracalai-revocation-redis
)
IMPORT_MODS=(
  caracalai_core
  caracalai_identity
  caracalai_revocation
  caracalai_sdk
  caracalai_transport_mcp
  caracalai_mcp_fastmcp
  caracalai_revocation_redis
)

runProbe() {
  local pkg="$1" mod="$2" ver="$3" dir="$4"
  case "$PM" in
    pip)
      if [[ "$DRY_RUN" == "1" ]]; then
        runOrEcho "$CARACAL_PYTHON" -m venv "$dir/v"
        runOrEcho "$dir/v/bin/pip" install --quiet "$pkg==$ver"
        runOrEcho "$dir/v/bin/python" -c "import $mod"
        return 0
      fi
      runOrEcho "$CARACAL_PYTHON" -m venv "$dir/v"
      local py="$dir/v/bin/python" pip="$dir/v/bin/pip"
      if [[ -f "$dir/v/Scripts/python.exe" ]]; then
        py="$dir/v/Scripts/python.exe"
        pip="$dir/v/Scripts/pip.exe"
      fi
      if [[ ! -f "$py" || ! -f "$pip" ]]; then
        echo "venv python or pip executable not found" >&2
        return 2
      fi
      runOrEcho "$pip" install --quiet "$pkg==$ver"
      runOrEcho "$py" -c "import $mod"
      ;;
    uv)
      runOrEcho uv init --quiet --no-readme --no-workspace "$dir/p"
      ( runOrEcho cd "$dir/p" && runOrEcho uv add --quiet "$pkg==$ver" && runOrEcho uv run --quiet python -c "import $mod" )
      ;;
    poetry)
      runOrEcho poetry --directory "$dir" new --quiet probe
      ( runOrEcho cd "$dir/probe" && runOrEcho poetry --quiet add "$pkg==$ver" && runOrEcho poetry --quiet run python -c "import $mod" )
      ;;
    *) echo "unknown PM=$PM" >&2; return 2 ;;
  esac
}

validateOne() {
  local pkg="$1" mod="$2"
  matchesOnly "$pkg" || return 0
  local ver; ver="$(manifestVersion pypi "$pkg" || true)"
  if [[ -z "$ver" ]]; then
    logFinding "$AREA" "$pkg" "manifest" "$PM" "py$PY" "$SEV_MAJOR" "$STATUS_FAIL" "no version pinned in manifest" "edit releases/$CARACAL_RELEASE/manifest.json"
    return 0
  fi
  local dir; dir="$(mktemp -d)"
  local plat; plat="$(hostPlatform)"
  if runProbe "$pkg" "$mod" "$ver" "$dir" 2>"$dir/err"; then
    logFinding "$AREA" "$pkg" "$plat" "$PM" "py$PY" "$SEV_INFO" "$STATUS_PASS" "install + import ok @ $ver" "$PM install $pkg==$ver"
  else
    local evid; evid="$(head -c 400 "$dir/err" | tr '\n' ' ' || true)"
    logFinding "$AREA" "$pkg" "$plat" "$PM" "py$PY" "$SEV_BLOCKER" "$STATUS_FAIL" "$evid" "$PM install $pkg==$ver"
  fi
  rm -rf "$dir"
}

for (( i = 0; i < ${#IMPORT_PKGS[@]}; i++ )); do
  validateOne "${IMPORT_PKGS[$i]}" "${IMPORT_MODS[$i]}"
done
