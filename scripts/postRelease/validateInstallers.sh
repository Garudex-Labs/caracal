#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Exercises install.sh and install.ps1 against the release tag and verifies the resulting binary version.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "$HERE/lib/common.sh"

readonly AREA="installers"
readonly REPO_ROOT="$(cd "$HERE/../.." && pwd)"
readonly PLAT="$(hostPlatform)"

validateShell() {
  matchesOnly "install.sh" || return 0
  local dir; dir="$(mktemp -d)"
  if CARACAL_INSTALL_DIR="$dir/bin" runOrEcho bash "$REPO_ROOT/install.sh" --version "$CARACAL_RELEASE" >"$dir/out" 2>&1; then
    if [[ "$DRY_RUN" == "1" ]] || "$dir/bin/caracal" --version 2>/dev/null | grep -q "$CLI_VER"; then
      logFinding "$AREA" "install.sh" "$PLAT" "shell" "-" "$SEV_INFO" "$STATUS_PASS" "installer placed caracal on PATH" "bash install.sh --version $CARACAL_RELEASE"
    else
      logFinding "$AREA" "install.sh" "$PLAT" "shell" "-" "$SEV_MAJOR" "$STATUS_FAIL" "installed binary --version did not match $CLI_VER" "bash install.sh --version $CARACAL_RELEASE"
    fi
  else
    logFinding "$AREA" "install.sh" "$PLAT" "shell" "-" "$SEV_BLOCKER" "$STATUS_FAIL" "$(head -c 400 "$dir/out")" "bash install.sh --version $CARACAL_RELEASE"
  fi
  rm -rf "$dir"
}

validatePwsh() {
  matchesOnly "install.ps1" || return 0
  if [[ "$PLAT" != windows-* ]]; then
    logFinding "$AREA" "install.ps1" "$PLAT" "pwsh" "-" "$SEV_INFO" "$STATUS_WARN" "PowerShell installer is only exercised on Windows runners" "pwsh -File install.ps1 -Version $CARACAL_RELEASE"
    return 0
  fi
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    logFinding "$AREA" "install.ps1" "$PLAT" "pwsh" "-" "$SEV_INFO" "$STATUS_PASS" "dry-run: would run pwsh install.ps1 -Version $CARACAL_RELEASE" "pwsh -File install.ps1 -Version $CARACAL_RELEASE"
    return 0
  fi
  if ! command -v pwsh >/dev/null 2>&1; then
    logFinding "$AREA" "install.ps1" "$PLAT" "pwsh" "-" "$SEV_INFO" "$STATUS_WARN" "pwsh not available on this runner" "pwsh -File install.ps1 -Version $CARACAL_RELEASE"
    return 0
  fi
  local dir; dir="$(mktemp -d)"
  if runOrEcho pwsh -NoProfile -File "$REPO_ROOT/install.ps1" -Version "$CARACAL_RELEASE" -InstallDir "$dir/bin" >"$dir/out" 2>&1; then
    logFinding "$AREA" "install.ps1" "$PLAT" "pwsh" "-" "$SEV_INFO" "$STATUS_PASS" "PowerShell installer completed" "pwsh -File install.ps1 -Version $CARACAL_RELEASE"
  else
    logFinding "$AREA" "install.ps1" "$PLAT" "pwsh" "-" "$SEV_BLOCKER" "$STATUS_FAIL" "$(head -c 400 "$dir/out")" "pwsh -File install.ps1 -Version $CARACAL_RELEASE"
  fi
  rm -rf "$dir"
}

validateShell
validatePwsh
