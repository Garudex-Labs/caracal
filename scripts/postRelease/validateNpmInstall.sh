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

prepareProject() {
  local dir="$1"; shift
  ( cd "$dir" && runOrEcho npm init -y >/dev/null )
  ( cd "$dir" && runOrEcho node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p));j.type='module';fs.writeFileSync(p,JSON.stringify(j,null,2));" )
  case "$PM" in
    npm)   ( cd "$dir" && export CI=1 && runOrEcho npm install --silent "$@" ) ;;
    pnpm)  ( cd "$dir" && export CI=1 && runOrEcho pnpm add --silent "$@" ) ;;
    yarn)  ( cd "$dir" && export CI=1 && runOrEcho yarn add --silent "$@" ) ;;
    *) echo "unknown PM=$PM" >&2; return 2 ;;
  esac
}

runProbe() {
  local pkg="$1" dir="$2"
  if [[ "$PM" == "yarn" ]]; then
    ( cd "$dir" && runOrEcho yarn node --input-type=module -e "const m = await import('$pkg'); if (m == null) process.exit(1);" )
  else
    ( cd "$dir" && runOrEcho node --input-type=module -e "const m = await import('$pkg'); if (m == null) process.exit(1);" )
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
  local plat; plat="$(hostPlatform)"
  if [[ "$installOk" != "1" ]]; then
    logFinding "$AREA" "$pkg" "$plat" "$PM" "node$NODE_V" "$SEV_BLOCKER" "$STATUS_FAIL" "$installEvidence" "$PM add $pkg@$ver"
    return 0
  fi
  if runProbe "$pkg" "$dir" >"$dir/err" 2>&1; then
    logFinding "$AREA" "$pkg" "$plat" "$PM" "node$NODE_V" "$SEV_INFO" "$STATUS_PASS" "install + ESM import ok @ $ver" "$PM add $pkg@$ver"
  else
    local evid; evid="$(head -c 400 "$dir/err" | tr '\n' ' ' || true)"
    logFinding "$AREA" "$pkg" "$plat" "$PM" "node$NODE_V" "$SEV_BLOCKER" "$STATUS_FAIL" "$evid" "$PM add $pkg@$ver"
  fi
}

dir="$(mktemp -d)"
installOk=0
installEvidence=""
specs=()
for (( i = 0; i < ${#NPM_NAMES[@]}; i++ )); do
  if matchesOnly "${NPM_NAMES[$i]}"; then
    specs+=("${NPM_NAMES[$i]}@${NPM_VERS[$i]}")
  fi
done
if (( ${#specs[@]} == 0 )); then
  logFinding "$AREA" "npm-packages" "manifest" "$PM" "node$NODE_V" "$SEV_INFO" "$STATUS_PASS" "no npm packages" "read releases/$CARACAL_RELEASE/manifest.json"
  rm -rf "$dir"
  exitForFindings
  exit $?
fi
if prepareProject "$dir" "${specs[@]}" >"$dir/install.log" 2>&1; then
  installOk=1
else
  installEvidence="$(head -c 400 "$dir/install.log" | tr '\n' ' ' || true)"
fi
for (( i = 0; i < ${#NPM_NAMES[@]}; i++ )); do validateOne "${NPM_NAMES[$i]}"; done
rm -rf "$dir"
exitForFindings
