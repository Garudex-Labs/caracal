#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Shared helpers and release-manifest loader for post-release validation sub-scripts.

set -euo pipefail

: "${CARACAL_RELEASE:?CARACAL_RELEASE must be set (e.g. v2026.05.26-rc.1)}"
: "${FINDINGS_DIR:?FINDINGS_DIR must be set}"

if command -v python3 >/dev/null 2>&1; then
  readonly CARACAL_PYTHON="python3"
elif command -v python >/dev/null 2>&1; then
  readonly CARACAL_PYTHON="python"
else
  echo "common.sh: python is required" >&2
  exit 2
fi

readonly SEV_BLOCKER="blocker"
readonly SEV_MAJOR="major"
readonly SEV_MINOR="minor"
readonly SEV_INFO="info"

readonly STATUS_PASS="pass"
readonly STATUS_WARN="warn"
readonly STATUS_FAIL="fail"
CARACAL_FINDINGS_FAILED=0

readonly DRY_RUN="${DRY_RUN:-0}"
readonly CARACAL_REPO="${CARACAL_REPO:-Garudex-Labs/caracal}"
readonly CARACAL_REGISTRY="${CARACAL_REGISTRY:-ghcr.io/garudex-labs}"
readonly CARACAL_IMAGE_PREFIX="${CARACAL_IMAGE_PREFIX:-caracal-}"

mkdir -p "$FINDINGS_DIR"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MANIFEST="${MANIFEST:-$REPO_ROOT/releases/$CARACAL_RELEASE/manifest.json}"

if [[ ! -f "$MANIFEST" ]]; then
  echo "common.sh: manifest not found at $MANIFEST" >&2
  exit 2
fi

PYPI_NAMES=()
PYPI_VERS=()
PYPI_MODULES=()
NPM_NAMES=()
NPM_VERS=()
CONTAINER_NAMES=()
CONTAINER_VERS=()
RUNTIME_IMAGE_VER=""
SHELL_VER=""
CONSOLE_VER=""

eval "$("$CARACAL_PYTHON" - "$MANIFEST" "$CARACAL_RELEASE" "$REPO_ROOT/release.config.json" <<'PY'
import json, os, shlex, sys
m = json.load(open(sys.argv[1]))
release = sys.argv[2]
if m.get("release") != release:
    raise SystemExit(f"manifest release {m.get('release')!r} does not match {release!r}")
config_path = sys.argv[3]
modules = {}
if os.path.exists(config_path):
    config = json.load(open(config_path))
    modules = {pkg["name"]: pkg["module"] for pkg in config.get("packages", {}).get("pypi", []) if "module" in pkg}
packages = m.get("packages", {})
published = packages.get("published", {}) if isinstance(packages, dict) else {}
pypi = published.get("pypi", m.get("pypi", {}))
npm = published.get("npm", m.get("npm", {}))
print(f'SHELL_VER={shlex.quote(m["binaries"]["shell"])}')
print(f'CONSOLE_VER={shlex.quote(m["binaries"]["console"])}')
if m.get("runtimeImage"):
    print(f'RUNTIME_IMAGE_VER={shlex.quote(m["runtimeImage"])}')
for k, v in m["containers"].items():
    print(f'CONTAINER_NAMES+=({shlex.quote(k)})')
    print(f'CONTAINER_VERS+=({shlex.quote(v)})')
for k, v in pypi.items():
    print(f'PYPI_NAMES+=({shlex.quote(k)})')
    print(f'PYPI_VERS+=({shlex.quote(v)})')
    print(f'PYPI_MODULES+=({shlex.quote(modules.get(k, k.replace("-", "_")))})')
for k, v in npm.items():
    print(f'NPM_NAMES+=({shlex.quote(k)})')
    print(f'NPM_VERS+=({shlex.quote(v)})')
PY
)"

manifestVersion() {
  local group="$1" name="$2" i
  case "$group" in
    pypi)
      for (( i = 0; i < ${#PYPI_NAMES[@]}; i++ )); do
        [[ "${PYPI_NAMES[$i]}" == "$name" ]] && { printf '%s' "${PYPI_VERS[$i]}"; return 0; }
      done
      ;;
    npm)
      for (( i = 0; i < ${#NPM_NAMES[@]}; i++ )); do
        [[ "${NPM_NAMES[$i]}" == "$name" ]] && { printf '%s' "${NPM_VERS[$i]}"; return 0; }
      done
      ;;
    container)
      for (( i = 0; i < ${#CONTAINER_NAMES[@]}; i++ )); do
        [[ "${CONTAINER_NAMES[$i]}" == "$name" ]] && { printf '%s' "${CONTAINER_VERS[$i]}"; return 0; }
      done
      ;;
  esac
  return 1
}

logFinding() {
  local area="$1" artifact="$2" platform="$3" pm="$4" runtime="$5" severity="$6" status="$7" evidence="$8" repro="$9"
  local file="$FINDINGS_DIR/${area}.jsonl"
  if [[ "$status" == "$STATUS_FAIL" ]]; then
    CARACAL_FINDINGS_FAILED=1
  fi
  "$CARACAL_PYTHON" -c '
import json, sys
print(json.dumps({
  "area": sys.argv[1], "artifact": sys.argv[2], "platform": sys.argv[3],
  "pm": sys.argv[4], "runtime": sys.argv[5], "severity": sys.argv[6],
  "status": sys.argv[7], "evidence": sys.argv[8], "repro": sys.argv[9]
}))
' "$area" "$artifact" "$platform" "$pm" "$runtime" "$severity" "$status" "$evidence" "$repro" >> "$file"
}

exitForFindings() {
  if [[ "$CARACAL_FINDINGS_FAILED" == "1" ]]; then
    return 1
  fi
  return 0
}

retryBackoff() {
  local attempts="${1:-10}" delay="${2:-120}"; shift 2
  local n=1
  until "$@"; do
    if (( n >= attempts )); then
      return 1
    fi
    sleep "$delay"
    n=$((n + 1))
  done
}

runOrEcho() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

matchesOnly() {
  local item="$1" only="${ONLY:-}"
  [[ -z "$only" ]] && return 0
  local IFS=','
  for entry in $only; do
    [[ "$item" == "$entry" ]] && return 0
  done
  return 1
}

sha256Check() {
  local sums="$1" file="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    grep " $file\$" "$sums" | sha256sum -c - >/dev/null
    return
  fi

  local expected actual
  expected="$(awk -v f="$file" '$2 == f {print $1; found=1} END {exit found ? 0 : 1}' "$sums")" || return 1
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]]
}

hostPlatform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    msys*|mingw*|cygwin*) os="windows" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
  esac
  printf '%s-%s' "$os" "$arch"
}
