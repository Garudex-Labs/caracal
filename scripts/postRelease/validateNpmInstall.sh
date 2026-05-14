#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Installs every npm package at its manifest-pinned version across npm, pnpm, and yarn.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "$HERE/lib/common.sh"

readonly AREA="npmInstall"
readonly PM="${PM:-npm}"
readonly NODE_V="${NODE_V:-22}"

runProbe() {
  local pkg="$1" ver="$2" dir="$3"
  ( cd "$dir" && runOrEcho npm init -y >/dev/null )
  runOrEcho node -e "const fs=require('fs');const p='$dir/package.json';const j=JSON.parse(fs.readFileSync(p));j.type='module';fs.writeFileSync(p,JSON.stringify(j,null,2));"
  case "$PM" in
    npm)   ( cd "$dir" && runOrEcho npm install --silent "$pkg@$ver" ) ;;
    pnpm)  ( cd "$dir" && runOrEcho pnpm add --silent "$pkg@$ver" ) ;;
    yarn)  ( cd "$dir" && runOrEcho yarn add --silent "$pkg@$ver" ) ;;
    *) echo "unknown PM=$PM" >&2; return 2 ;;
  esac
  if [[ "$PM" == "yarn" ]]; then
    ( cd "$dir" && runOrEcho yarn node --input-type=module -e "const m = await import('$pkg'); if (!m) process.exit(1);" )
  else
    ( cd "$dir" && runOrEcho node --input-type=module -e "const m = await import('$pkg'); if (!m) process.exit(1);" )
  fi
}

validateOne() {
  local pkg="$1"
  matchesOnly "$pkg" || return 0
  local ver; ver="$(manifestVersion npm "$pkg" || true)"
  if [[ -z "$ver" ]]; then
    logFinding "$AREA" "$pkg" "manifest" "$PM" "node$NODE_V" "$SEV_MAJOR" "$STATUS_FAIL" "no version pinned in manifest" "edit releases/$CARACAL_RELEASE/manifest.json"
    return 0
  fi
  local dir; dir="$(mktemp -d)"
  local plat; plat="$(hostPlatform)"
  if runProbe "$pkg" "$ver" "$dir" 2>"$dir/err"; then
    logFinding "$AREA" "$pkg" "$plat" "$PM" "node$NODE_V" "$SEV_INFO" "$STATUS_PASS" "install + ESM import ok @ $ver" "$PM add $pkg@$ver"
  else
    local evid; evid="$(head -c 400 "$dir/err" | tr '\n' ' ' || true)"
    logFinding "$AREA" "$pkg" "$plat" "$PM" "node$NODE_V" "$SEV_BLOCKER" "$STATUS_FAIL" "$evid" "$PM add $pkg@$ver"
  fi
  rm -rf "$dir"
}

for (( i = 0; i < ${#NPM_NAMES[@]}; i++ )); do validateOne "${NPM_NAMES[$i]}"; done
