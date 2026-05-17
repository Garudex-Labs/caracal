#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Verifies SLSA provenance for release archives and container images pinned by the manifest.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "$HERE/lib/common.sh"

readonly AREA="provenance"
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
    logFinding "$AREA" "$img" "ghcr" "docker" "-" "$SEV_INFO" "$STATUS_PASS" "dry-run: would inspect OCI SLSA provenance for $img" "docker buildx imagetools inspect $img"
    return 0
  fi
  if ! command -v docker >/dev/null 2>&1; then
    logFinding "$AREA" "$img" "ghcr" "docker" "-" "$SEV_INFO" "$STATUS_WARN" "docker not available" "docker buildx imagetools inspect $img"
    return 0
  fi
  local dir; dir="$(mktemp -d)"
  if runOrEcho docker buildx imagetools inspect "$img" --format '{{json .Provenance}}' >"$dir/out" 2>"$dir/err" && grep -q '"SLSA"' "$dir/out"; then
    logFinding "$AREA" "$img" "ghcr" "docker" "-" "$SEV_INFO" "$STATUS_PASS" "image SLSA provenance found" "docker buildx imagetools inspect $img"
  else
    logFinding "$AREA" "$img" "ghcr" "docker" "-" "$SEV_BLOCKER" "$STATUS_FAIL" "$(cat "$dir/err" "$dir/out" 2>/dev/null | head -c 400)" "docker buildx imagetools inspect $img"
  fi
  rm -rf "$dir"
}

for p in "${PLATS[@]}"; do
  verifyArchive "$(archiveFor shell "$p")"
  verifyArchive "$(archiveFor cli "$p")"
  verifyArchive "$(archiveFor tui "$p")"
done
for (( i = 0; i < ${#CONTAINER_NAMES[@]}; i++ )); do verifyImage "${CONTAINER_NAMES[$i]}" "${CONTAINER_VERS[$i]}"; done
