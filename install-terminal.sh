#!/usr/bin/env sh
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Standalone TUI installer that downloads, verifies, and extracts Caracal release archives.

set -eu

REPO="Garudex-Labs/caracal"
INSTALL_DIR="${CARACAL_INSTALL_DIR:-${HOME}/.local/bin}"
VERSION="${CARACAL_VERSION:-latest}"

err() {
    printf 'caracal-install: %s\n' "$1" >&2
    exit 1
}

usage() {
    cat <<EOF
caracal-install: download the Caracal TUI binaries from GitHub Releases.

Usage:
  install-tui.sh [--version vYYYY.MM.DD[.N]] [--install-dir PATH]

Installs the thin 'caracal' shell and the 'caracal-tui' terminal UI binary.

Environment overrides:
  CARACAL_VERSION       same as --version
  CARACAL_INSTALL_DIR   same as --install-dir
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version) [ $# -ge 2 ] || err "--version requires a value"; VERSION="$2"; shift ;;
        --install-dir) [ $# -ge 2 ] || err "--install-dir requires a value"; INSTALL_DIR="$2"; shift ;;
        --help|-h) usage; exit 0 ;;
        *) err "unknown argument: $1 (use --help for usage)" ;;
    esac
    shift
done

require() {
    command -v "$1" >/dev/null 2>&1 || err "missing required command: $1"
}

require uname
require mkdir
require chmod
require tar

if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -qO "$2" "$1"; }
else
    err "neither curl nor wget is installed"
fi

if command -v sha256sum >/dev/null 2>&1; then
    sha() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
    sha() { shasum -a 256 "$1" | awk '{print $1}'; }
else
    err "neither sha256sum nor shasum installed; refusing without integrity check"
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
machine="$(uname -m)"
case "${machine}" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) err "unsupported architecture: ${machine}" ;;
esac
case "${os}" in
    linux) ext=tar.gz ;;
    darwin) ext=tar.gz ;;
    msys*|mingw*|cygwin*|windowsnt)
        os=windows
        ext=zip
        [ "${arch}" = arm64 ] && err "Windows arm64 binaries are not published; use install-tui.ps1 on Windows"
        require unzip
        ;;
    *) err "unsupported OS: ${os}" ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

if [ "${VERSION}" = "latest" ]; then
    fetch "https://api.github.com/repos/${REPO}/releases/latest" "${tmp}/_latest.json" \
        || err "failed to resolve latest release from GitHub API"
    tag="$(awk -F'"' '/"tag_name":/ {print $4; exit}' "${tmp}/_latest.json")"
    [ -n "${tag}" ] || err "could not parse tag_name from GitHub API response"
else
    tag="${VERSION}"
fi
case "${tag}" in
    v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]|v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9].[0-9]*|v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]-rc.*|v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9].[0-9]*-rc.*) ;;
    *) err "release tag ${tag} is not a supported Caracal release tag" ;;
esac
base="https://github.com/${REPO}/releases/download/${tag}"

printf 'caracal-install: target release %s (%s-%s)\n' "${tag}" "${os}" "${arch}"
printf 'caracal-install: downloading SHA256SUMS\n'
fetch "${base}/SHA256SUMS" "${tmp}/SHA256SUMS" || err "failed to download SHA256SUMS"

installArchive() {
    kind="$1"
    binName="$2"
    archive="caracal-${kind}-${os}-${arch}-${tag}.${ext}"
    expected="$(awk -v n="${archive}" '$2 == n || $2 == "*"n {print $1}' "${tmp}/SHA256SUMS")"
    [ -n "${expected}" ] || err "no checksum for ${archive} in SHA256SUMS"

    printf 'caracal-install: downloading %s\n' "${archive}"
    fetch "${base}/${archive}" "${tmp}/${archive}" || err "failed to download ${archive}"
    actual="$(sha "${tmp}/${archive}")"
    [ "${expected}" = "${actual}" ] || err "checksum mismatch for ${archive}: expected ${expected}, got ${actual}"

    case "${ext}" in
        tar.gz) tar -xzf "${tmp}/${archive}" -C "${tmp}" ;;
        zip) unzip -q -o "${tmp}/${archive}" -d "${tmp}" ;;
    esac

    binFile="${binName}"
    [ "${os}" = windows ] && binFile="${binName}.exe"
    [ -f "${tmp}/${binFile}" ] || err "expected ${binFile} inside ${archive}, not found"

    dest="${INSTALL_DIR}/${binFile}"
    mv "${tmp}/${binFile}" "${dest}"
    chmod +x "${dest}"
    printf 'caracal-install: installed %s\n' "${dest}"
}

hasArchive() {
    archive="caracal-${1}-${os}-${arch}-${tag}.${ext}"
    awk -v n="${archive}" '$2 == n || $2 == "*"n {found=1} END {exit found ? 0 : 1}' "${tmp}/SHA256SUMS"
}

mkdir -p "${INSTALL_DIR}"
installedShell=0
if hasArchive shell; then
    installedShell=1
    installArchive shell caracal
fi
installArchive tui caracal-tui

case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) ;;
    *) printf 'caracal-install: add %s to PATH (e.g. export PATH="%s:$PATH")\n' "${INSTALL_DIR}" "${INSTALL_DIR}" ;;
esac

checkShadow() {
    binName="$1"
    shadow=""
    IFS=":"
    for dir in ${PATH}; do
        [ -z "${dir}" ] && continue
        [ "${dir}" = "${INSTALL_DIR}" ] && break
        if [ -e "${dir}/${binName}" ] || [ -L "${dir}/${binName}" ]; then
            shadow="${dir}/${binName}"
            break
        fi
    done
    unset IFS
    if [ -n "${shadow}" ]; then
        printf 'caracal-install: warning: %s appears earlier in PATH than %s.\n' "${shadow}" "${INSTALL_DIR}" >&2
        printf 'caracal-install: remove it to use the installed binary: rm "%s"\n' "${shadow}" >&2
    fi
}

[ "${installedShell}" = "1" ] && checkShadow caracal
checkShadow caracal-tui

printf 'caracal-install: done. Next steps:\n'
printf '  installed release %s (mode: stable)\n' "${tag}"
printf '  hash -r            # refresh your shell command cache\n'
[ "${installedShell}" = "1" ] && printf '  caracal tui        # launch the interactive TUI through the shell\n'
printf '  caracal-tui        # launch the interactive TUI directly\n'
printf 'caracal-install: CLI not installed; install it with install-cli.sh when needed\n'
printf 'caracal-install: to uninstall, remove'
[ "${installedShell}" = "1" ] && printf ' %s/caracal' "${INSTALL_DIR}"
printf ' %s/caracal-tui\n' "${INSTALL_DIR}"
