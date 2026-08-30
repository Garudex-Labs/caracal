#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# Caracal Server Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install-server.sh | bash -s -- [OPTIONS]
#
# Options:
#   --version VERSION          Version to install (default: latest)
#   --install-dir DIR          Install directory (default: ~/.caracal on macOS, /opt/caracal on Linux)
#   --force                    Skip overwrite confirmation on re-install
#
# Environment variable overrides (lower priority than flags):
#   CARACAL_VERSION=latest    Version to install
#   CARACAL_INSTALL_DIR       Install directory
#   CARACAL_FORCE=1           Skip overwrite confirmation

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
FORCE="${CARACAL_FORCE:-0}"
BASE_URL="${CARACAL_BASE_URL:-}"

# Default install directory
if [ -z "${CARACAL_INSTALL_DIR:-}" ]; then
    case "$(uname -s)" in
    Darwin) INSTALL_DIR="$HOME/.caracal" ;;
    *) INSTALL_DIR="/opt/caracal" ;;
    esac
else
    INSTALL_DIR="$CARACAL_INSTALL_DIR"
fi

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
    --install-dir)
        [ -n "${2:-}" ] || die "--install-dir requires a value"
        INSTALL_DIR="$2"
        shift 2
        ;;
    --install-dir=*)
        INSTALL_DIR="${1#--install-dir=}"
        shift
        ;;
    --force)
        FORCE=1
        shift
        ;;
    -h | --help)
        cat <<'HELP'
Caracal Server Installer
Usage: curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install-server.sh | bash -s -- [OPTIONS]

Options:
  --version VERSION    Version to install (default: latest)
  --install-dir DIR    Install directory (default: ~/.caracal on macOS, /opt/caracal on Linux)
  --force              Skip overwrite confirmation on re-install

Environment variable overrides (lower priority than flags):
  CARACAL_VERSION       Version to install
  CARACAL_INSTALL_DIR   Install directory
  CARACAL_FORCE=1       Skip overwrite confirmation
HELP
        exit 0
        ;;
    *)
        die "Unknown option: $1"
        ;;
    esac
done

# ── Pre-flight ───────────────────────────────────────────────

command -v curl >/dev/null 2>&1 || die "'curl' is required but not found."
command -v docker >/dev/null 2>&1 || die "Docker is required. Install: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."

# ── Resolve version ──────────────────────────────────────────

if [ "$VERSION" = "latest" ]; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/$GITHUB_REPO/releases/latest" |
        grep '"tag_name"' | head -1 | cut -d'"' -f4)
    [ -n "$VERSION" ] || die "Could not determine latest version"
fi

info "Installing Caracal Server $VERSION"

# ── Download ─────────────────────────────────────────────────

ARTIFACT="caracal-server-${VERSION}.tar.gz"

if [ -n "$BASE_URL" ]; then
    URL="${BASE_URL}/${ARTIFACT}"
else
    URL="https://github.com/$GITHUB_REPO/releases/download/$VERSION/$ARTIFACT"
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

info "Downloading server package..."
if ! curl -fsSL -o "$TMPDIR/$ARTIFACT" "$URL"; then
    die "Download failed. Check that $VERSION exists at https://github.com/$GITHUB_REPO/releases"
fi

# ── Unpack ───────────────────────────────────────────────────

if [ -d "$INSTALL_DIR" ] && [ "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    if [ "$FORCE" = "1" ]; then
        info "Overwriting existing installation at $INSTALL_DIR"
    else
        warn "Directory $INSTALL_DIR already exists and is not empty."
        printf 'Overwrite? [y/N]: '
        read -r confirm </dev/tty
        [ "$confirm" = "y" ] || [ "$confirm" = "Y" ] || die "Aborted."
    fi
fi

info "Unpacking to $INSTALL_DIR..."
if [ -w "$(dirname "$INSTALL_DIR")" ]; then
    mkdir -p "$INSTALL_DIR"
    tar -xzf "$TMPDIR/$ARTIFACT" -C "$INSTALL_DIR" --strip-components=1
else
    sudo mkdir -p "$INSTALL_DIR"
    sudo tar -xzf "$TMPDIR/$ARTIFACT" -C "$INSTALL_DIR" --strip-components=1
    sudo chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"
fi

# ── Run setup ───────────────────────────────────────────────

if ( : </dev/tty ) 2>/dev/null; then
    info "Running guided setup..."
    CARACAL_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALL_DIR/setup.sh" </dev/tty
else
    info "No terminal detected; using safe setup defaults..."
    CARACAL_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALL_DIR/setup.sh" </dev/null
fi
