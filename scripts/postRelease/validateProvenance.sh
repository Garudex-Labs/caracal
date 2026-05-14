#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Verifies SLSA provenance for release archives and cosign signatures for every container image pinned by the manifest.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "$HERE/lib/common.sh"

readonly AREA="provenance"
readonly IDENT_RE="^https://github.com/$CARACAL_REPO"
readonly PLATS=(linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64)

archiveFor() {
  local kind="$1" plat="$2" ext=".tar.gz"
  [[ "$plat" == windows-* ]] && ext=".zip"
  printf 'caracal-%s-%s-%s%s' "$kind" "$plat" "$CARACAL_RELEASE" "$ext"
}

verifyArchive() {
  local file="$1"
  matchesOnly "$file" || return 0
  if ! command -v gh >/dev/null 2>&1; then
    logFinding "$AREA" "$file" "github" "gh" "-" "$SEV_INFO" "$STATUS_WARN" "gh CLI not available" "gh attestation verify $file"
    return 0
  fi
  local dir; dir="$(mktemp -d)"
  if ! runOrEcho curl -fsSL -o "$dir/$file" "https://github.com/$CARACAL_REPO/releases/download/$CARACAL_RELEASE/$file"; then
    logFinding "$AREA" "$file" "github" "gh" "-" "$SEV_MAJOR" "$STATUS_FAIL" "download failed" "curl $file"
    rm -rf "$dir"; return 0
  fi
  if runOrEcho gh attestation verify "$dir/$file" --repo "$CARACAL_REPO" >"$dir/out" 2>&1; then
    logFinding "$AREA" "$file" "github" "gh" "-" "$SEV_INFO" "$STATUS_PASS" "attestation verified" "gh attestation verify $file --repo $CARACAL_REPO"
  else
    logFinding "$AREA" "$file" "github" "gh" "-" "$SEV_BLOCKER" "$STATUS_FAIL" "$(head -c 400 "$dir/out")" "gh attestation verify $file --repo $CARACAL_REPO"
  fi
  rm -rf "$dir"
}

verifyImage() {
  local svc="$1" ver="$2"
  local img="$CARACAL_REGISTRY/${CARACAL_IMAGE_PREFIX}${svc}:v$ver"
  matchesOnly "$svc" || return 0
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    logFinding "$AREA" "$img" "ghcr" "cosign" "-" "$SEV_INFO" "$STATUS_PASS" "dry-run: would cosign verify $img" "cosign verify $img"
    return 0
  fi
  if ! command -v cosign >/dev/null 2>&1; then
    logFinding "$AREA" "$img" "ghcr" "cosign" "-" "$SEV_INFO" "$STATUS_WARN" "cosign not available" "cosign verify $img"
    return 0
  fi
  if runOrEcho cosign verify "$img" --certificate-identity-regexp "$IDENT_RE" --certificate-oidc-issuer https://token.actions.githubusercontent.com >/dev/null 2>&1; then
    logFinding "$AREA" "$img" "ghcr" "cosign" "-" "$SEV_INFO" "$STATUS_PASS" "image signature verified" "cosign verify $img"
  else
    logFinding "$AREA" "$img" "ghcr" "cosign" "-" "$SEV_BLOCKER" "$STATUS_FAIL" "cosign verify failed" "cosign verify $img"
  fi
}

for p in "${PLATS[@]}"; do
  verifyArchive "$(archiveFor cli "$p")"
  verifyArchive "$(archiveFor tui "$p")"
done
for (( i = 0; i < ${#CONTAINER_NAMES[@]}; i++ )); do verifyImage "${CONTAINER_NAMES[$i]}" "${CONTAINER_VERS[$i]}"; done
