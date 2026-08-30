#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# Caracal CLI Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install.sh | bash -s -- [OPTIONS]
#
# Options:
#   --version VERSION          Version to install (default: latest)
#   --bin-dir DIR              Install directory (default: /usr/local/bin)
#
# Environment variable overrides (lower priority than flags):
#   CARACAL_VERSION=latest    Version to install
#   CARACAL_BIN_DIR=/path     Install directory

GITHUB_REPO="Garudex-Labs/caracal"


# ── Helpers ──────────────────────────────────────────────────

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*"; }
error() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; }
die() {
    error "$@"
    exit 1
}

# ── Parse arguments ──────────────────────────────────────────

VERSION="${CARACAL_VERSION:-latest}"
BIN_DIR="${CARACAL_BIN_DIR:-/usr/local/bin}"
BASE_URL="${CARACAL_BASE_URL:-}" # Override for testing (e.g. http://localhost:9999)

while [ $# -gt 0 ]; do
    case "$1" in
    --license-key)
        [ -n "${2:-}" ] || die "--license-key requires a value"
        shift 2
        ;;
    --license-key=*)
        shift
        ;;
    --version)
        [ -n "${2:-}" ] || die "--version requires a value"
        VERSION="$2"
        shift 2
        ;;
    --version=*)
        VERSION="${1#--version=}"
        shift
        ;;
    --bin-dir)
        [ -n "${2:-}" ] || die "--bin-dir requires a value"
        BIN_DIR="$2"
        shift 2
        ;;
    --bin-dir=*)
        BIN_DIR="${1#--bin-dir=}"
        shift
        ;;
    -h | --help)
        cat <<'HELP'
Caracal CLI Installer
Usage: curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install.sh | bash -s -- [OPTIONS]

Options:
  --version VERSION   Version to install (default: latest)
  --bin-dir DIR       Install directory (default: /usr/local/bin)

Environment variable overrides (lower priority than flags):
  CARACAL_VERSION       Version to install
  CARACAL_BIN_DIR       Install directory
HELP
        exit 0
        ;;
    *)
        die "Unknown option: $1"
        ;;
    esac
done

# ── Detect platform ──────────────────────────────────────────

detect_os() {
    case "$(uname -s)" in
    Linux*) echo "linux" ;;
    Darwin*) echo "macos" ;;
    MINGW* | MSYS* | CYGWIN*) echo "windows" ;;
    *) die "Unsupported OS: $(uname -s)" ;;
    esac
}

detect_arch() {
    case "$(uname -m)" in
    x86_64 | amd64) echo "x64" ;;
    aarch64 | arm64) echo "arm64" ;;
    *) die "Unsupported architecture: $(uname -m)" ;;
    esac
}

OS=$(detect_os)
ARCH=$(detect_arch)

# ── Resolve version ──────────────────────────────────────────

command -v curl >/dev/null 2>&1 || die "'curl' is required but not found."

if [ "$VERSION" = "latest" ]; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/$GITHUB_REPO/releases/latest" |
        grep '"tag_name"' | head -1 | cut -d'"' -f4)
    [ -n "$VERSION" ] || die "Could not determine latest version"
elif [ "${VERSION#v}" = "$VERSION" ]; then
    VERSION="v$VERSION"
fi

info "Installing Caracal CLI $VERSION ($OS/$ARCH)"

# ── Download and verify ──────────────────────────────────────

EXT=""
[ "$OS" = "windows" ] && EXT=".exe"

ARTIFACT="caracal-${OS}-${ARCH}${EXT}"

if [ -n "$BASE_URL" ]; then
    URL="${BASE_URL}/${ARTIFACT}"
    CHECKSUM_URL="${BASE_URL}/checksums.txt"
else
    URL="https://github.com/$GITHUB_REPO/releases/download/$VERSION/$ARTIFACT"
    CHECKSUM_URL="https://github.com/$GITHUB_REPO/releases/download/$VERSION/checksums.txt"
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

info "Downloading $ARTIFACT..."
if ! curl -fsSL -o "$TMPDIR/$ARTIFACT" "$URL"; then
    die "Download failed. Check that $VERSION exists at https://github.com/$GITHUB_REPO/releases"
fi

info "Verifying checksum..."
curl -fsSL -o "$TMPDIR/checksums.txt" "$CHECKSUM_URL" || warn "Could not download checksums -- skipping verification"
if [ -f "$TMPDIR/checksums.txt" ]; then
    EXPECTED=$(grep "$ARTIFACT" "$TMPDIR/checksums.txt" | awk '{print $1}')
    if [ -n "$EXPECTED" ]; then
        if command -v sha256sum >/dev/null 2>&1; then
            ACTUAL=$(sha256sum "$TMPDIR/$ARTIFACT" | awk '{print $1}')
        else
            ACTUAL=$(shasum -a 256 "$TMPDIR/$ARTIFACT" | awk '{print $1}')
        fi
        [ "$ACTUAL" = "$EXPECTED" ] || die "Checksum mismatch! Expected: $EXPECTED Got: $ACTUAL"
        info "Checksum verified"
    fi
fi

# ── Install ──────────────────────────────────────────────────

INSTALL_PATH="${BIN_DIR}/caracal${EXT}"
if [ -w "$BIN_DIR" ]; then
    mv "$TMPDIR/$ARTIFACT" "$INSTALL_PATH"
    chmod +x "$INSTALL_PATH"
else
    info "Installing to $BIN_DIR requires sudo"
    sudo mv "$TMPDIR/$ARTIFACT" "$INSTALL_PATH"
    sudo chmod +x "$INSTALL_PATH"
fi

# ── Write install metadata ──────────────────────────────────

CONFIG_DIR="${HOME}/.caracal"
mkdir -p "$CONFIG_DIR"
INSTALL_METADATA="$CONFIG_DIR/install.json"
json_escape() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if ! cat >"$INSTALL_METADATA" <<EOF
{
  "method": "curl",
  "manager": "curl",
  "path": "$(json_escape "$INSTALL_PATH")",
  "version": "$(json_escape "$VERSION")"
}
EOF
then
    warn "Could not write install metadata to $INSTALL_METADATA"
fi

info "Installed caracal to $INSTALL_PATH"
info "Run 'caracal --version' to verify."
