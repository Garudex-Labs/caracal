#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Verifies PyPI and npm registry metadata against the per-artifact versions in the release manifest.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "$HERE/lib/common.sh"

readonly AREA="registryMetadata"

checkPyPi() {
  local pkg="$1" ver="$2"
  matchesOnly "$pkg" || return 0
  local url="https://pypi.org/pypi/$pkg/json"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] curl %s (expect %s)\n' "$url" "$ver"
    logFinding "$AREA" "$pkg" "registry" "pypi" "-" "$SEV_INFO" "$STATUS_PASS" "dry-run: would check $url for $ver" "curl -fsSL $url"
    return 0
  fi
  local body
  if ! body="$(retryBackoff 10 120 curl -fsSL "$url")"; then
    logFinding "$AREA" "$pkg" "registry" "pypi" "-" "$SEV_BLOCKER" "$STATUS_FAIL" "package not found on PyPI" "curl -fsSL $url"
    return 0
  fi
  local got
  got="$(printf '%s' "$body" | "$CARACAL_PYTHON" -c "import json,sys;d=json.load(sys.stdin);print(d['info']['version'])")"
  if [[ "$got" != "$ver" ]]; then
    logFinding "$AREA" "$pkg" "registry" "pypi" "-" "$SEV_BLOCKER" "$STATUS_FAIL" "version mismatch: got $got expected $ver" "curl $url | jq .info.version"
    return 0
  fi
  local lic
  lic="$(printf '%s' "$body" | "$CARACAL_PYTHON" -c "import json,sys;d=json.load(sys.stdin);print(d['info'].get('license') or '')")"
  if [[ "$lic" != *"Apache"* && "$lic" != *"apache"* ]]; then
    logFinding "$AREA" "$pkg" "registry" "pypi" "-" "$SEV_MAJOR" "$STATUS_WARN" "license not Apache-2.0: '$lic'" "curl $url | jq .info.license"
  fi
  logFinding "$AREA" "$pkg" "registry" "pypi" "-" "$SEV_INFO" "$STATUS_PASS" "metadata ok @ $ver" "curl $url"
}

checkNpm() {
  local pkg="$1" ver="$2"
  matchesOnly "$pkg" || return 0
  local url="https://registry.npmjs.org/${pkg}"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] curl %s (expect %s)\n' "$url" "$ver"
    logFinding "$AREA" "$pkg" "registry" "npm" "-" "$SEV_INFO" "$STATUS_PASS" "dry-run: would check $url for $ver" "curl -fsSL $url"
    return 0
  fi
  local body
  if ! body="$(retryBackoff 10 120 curl -fsSL "$url")"; then
    logFinding "$AREA" "$pkg" "registry" "npm" "-" "$SEV_BLOCKER" "$STATUS_FAIL" "package not found on npm" "curl -fsSL $url"
    return 0
  fi
  local hasV
  hasV="$(printf '%s' "$body" | V="$ver" "$CARACAL_PYTHON" -c "import json,sys,os;d=json.load(sys.stdin);print('yes' if os.environ['V'] in d.get('versions',{}) else 'no')")"
  if [[ "$hasV" != "yes" ]]; then
    logFinding "$AREA" "$pkg" "registry" "npm" "-" "$SEV_BLOCKER" "$STATUS_FAIL" "version $ver missing from versions[]" "curl $url | jq '.versions | keys'"
    return 0
  fi
  local lic
  lic="$(printf '%s' "$body" | V="$ver" "$CARACAL_PYTHON" -c "import json,sys,os;d=json.load(sys.stdin);print(d['versions'][os.environ['V']].get('license') or '')")"
  if [[ "$lic" != *"Apache"* ]]; then
    logFinding "$AREA" "$pkg" "registry" "npm" "-" "$SEV_MAJOR" "$STATUS_WARN" "license not Apache-2.0: '$lic'" "curl $url | jq .versions[\"$ver\"].license"
  fi
  logFinding "$AREA" "$pkg" "registry" "npm" "-" "$SEV_INFO" "$STATUS_PASS" "metadata ok @ $ver" "curl $url"
}

for (( i = 0; i < ${#PYPI_NAMES[@]}; i++ )); do checkPyPi "${PYPI_NAMES[$i]}" "${PYPI_VERS[$i]}"; done
for (( i = 0; i < ${#NPM_NAMES[@]}; i++ )); do checkNpm "${NPM_NAMES[$i]}" "${NPM_VERS[$i]}"; done
