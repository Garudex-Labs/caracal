#!/usr/bin/env sh
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Standalone Console installer that downloads, verifies, and extracts Caracal release archives.

set -eu

REPO="Garudex-Labs/caracal"
INSTALL_PREFIX="${CARACAL_PREFIX:-${PREFIX:-${HOME}/.local}}"
INSTALL_DIR="${CARACAL_INSTALL_DIR:-${INSTALL_PREFIX}/bin}"
INSTALL_DIR_EXPLICIT=0
[ -n "${CARACAL_INSTALL_DIR:-}" ] && INSTALL_DIR_EXPLICIT=1
DESTDIR_VALUE="${DESTDIR:-}"
VERSION="${CARACAL_VERSION:-latest}"
VERIFY_PROVENANCE="${CARACAL_VERIFY_PROVENANCE:-1}"
REQUIRE_PROVENANCE="${CARACAL_REQUIRE_PROVENANCE:-1}"
COLOR_MODE="${CARACAL_INSTALL_COLOR:-default}"
PROGRESS_MODE="${CARACAL_INSTALL_PROGRESS:-default}"
UNINSTALL=0

colorReset=""
colorBold=""
colorCyan=""
colorGreen=""
colorYellow=""
colorRed=""
useProgress=0

configureColor() {
    useColor=0
    case "${COLOR_MODE}" in
        always|1|true|yes) useColor=1 ;;
        never|0|false|no) useColor=0 ;;
        default|"")
            if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ] && [ "${CI:-}" != "true" ]; then
                useColor=1
            fi
            ;;
        auto)
            if { [ -t 1 ] || [ -t 2 ]; } && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
                useColor=1
            fi
            ;;
        *) err "unsupported color mode: ${COLOR_MODE} (use default, auto, always, or never)" ;;
    esac
    if [ "${useColor}" = "1" ]; then
        colorReset="$(printf '\033[0m')"
        colorBold="$(printf '\033[1m')"
        colorCyan="$(printf '\033[36m')"
        colorGreen="$(printf '\033[32m')"
        colorYellow="$(printf '\033[33m')"
        colorRed="$(printf '\033[31m')"
    else
        colorReset=""
        colorBold=""
        colorCyan=""
        colorGreen=""
        colorYellow=""
        colorRed=""
    fi
    brand="${colorBold}caracal-install${colorReset}"
}

brand="${colorBold}caracal-install${colorReset}"

configureProgress() {
    useProgress=0
    case "${PROGRESS_MODE}" in
        always|1|true|yes) useProgress=1 ;;
        never|0|false|no) useProgress=0 ;;
        default|"")
            if [ "${TERM:-}" != "dumb" ] && [ "${CI:-}" != "true" ]; then
                useProgress=1
            fi
            ;;
        auto)
            if [ -t 2 ] && [ "${TERM:-}" != "dumb" ] && [ "${CI:-}" != "true" ]; then
                useProgress=1
            fi
            ;;
        *) err "unsupported progress mode: ${PROGRESS_MODE} (use default, auto, always, or never)" ;;
    esac
}

step() {
    printf '%s %s==>%s %s\n' "${brand}" "${colorCyan}" "${colorReset}" "$1"
}

ok() {
    printf '%s %s[OK]%s %s\n' "${brand}" "${colorGreen}" "${colorReset}" "$1"
}

info() {
    printf '%s %s[INFO]%s %s\n' "${brand}" "${colorCyan}" "${colorReset}" "$1"
}

warn() {
    printf '%s %s[WARN]%s %s\n' "${brand}" "${colorYellow}" "${colorReset}" "$1" >&2
}

section() {
    printf '\n%s %s%s%s\n' "${brand}" "${colorBold}" "$1" "${colorReset}"
}

err() {
    printf '%s %s[ERROR]%s %s\n' "${brand}" "${colorRed}" "${colorReset}" "$1" >&2
    exit 1
}

usage() {
    cat <<EOF
caracal-install: download the Caracal Console binaries from GitHub Releases.

Usage:
  install-console.sh [--version vYYYY.MM.DD[.N][-rc.N]] [--prefix PATH] [--install-dir PATH] [--destdir PATH] [--uninstall] [--no-verify-provenance]

Installs the thin 'caracal' runtime CLI and the 'caracal-console' Console binary.

Provenance attestation is required by default. Pass --no-verify-provenance only
when you explicitly need to skip release provenance verification.

Color and download progress are enabled by default for local installs. Set
NO_COLOR=1, CARACAL_INSTALL_COLOR=never, or CARACAL_INSTALL_PROGRESS=never for
plain output.

Environment overrides:
  CARACAL_VERSION       same as --version
  CARACAL_PREFIX        install prefix; default: ${HOME}/.local
  CARACAL_INSTALL_DIR   same as --install-dir
  DESTDIR               staging root prepended to the install directory
  CARACAL_VERIFY_PROVENANCE   set 0 to disable provenance verification
  CARACAL_REQUIRE_PROVENANCE  set 0 to verify only when gh is available
  CARACAL_INSTALL_COLOR default, auto, always, or never
  CARACAL_INSTALL_PROGRESS default, auto, always, or never
EOF
}

configureColor
configureProgress
while [ $# -gt 0 ]; do
    case "$1" in
        --version) [ $# -ge 2 ] || err "--version requires a value"; VERSION="$2"; shift ;;
        --prefix)
            [ $# -ge 2 ] || err "--prefix requires a value"
            INSTALL_PREFIX="$2"
            if [ "${INSTALL_DIR_EXPLICIT}" != "1" ]; then
                INSTALL_DIR="${INSTALL_PREFIX}/bin"
            fi
            shift
            ;;
        --install-dir)
            [ $# -ge 2 ] || err "--install-dir requires a value"
            INSTALL_DIR="$2"
            INSTALL_DIR_EXPLICIT=1
            shift
            ;;
        --destdir) [ $# -ge 2 ] || err "--destdir requires a value"; DESTDIR_VALUE="$2"; shift ;;
        --uninstall) UNINSTALL=1 ;;
        --no-verify-provenance) VERIFY_PROVENANCE=0; REQUIRE_PROVENANCE=0 ;;
        --help|-h) usage; exit 0 ;;
        *) err "unknown argument: $1 (use --help for usage)" ;;
    esac
    shift
done
configureColor
configureProgress
if [ "${VERIFY_PROVENANCE}" != "1" ]; then
    REQUIRE_PROVENANCE=0
fi

installPath() {
    if [ -z "${DESTDIR_VALUE}" ]; then
        printf '%s' "$1"
        return
    fi
    case "$1" in
        /*) printf '%s%s' "${DESTDIR_VALUE%/}" "$1" ;;
        *) printf '%s/%s' "${DESTDIR_VALUE%/}" "$1" ;;
    esac
}

INSTALL_PATH="$(installPath "${INSTALL_DIR}")"

uninstall() {
    removed=0
    if [ -d "${INSTALL_PATH}" ]; then
        for binFile in caracal caracal.exe caracal-console caracal-console.exe; do
            if [ -e "${INSTALL_PATH}/${binFile}" ] || [ -L "${INSTALL_PATH}/${binFile}" ]; then
                rm -f "${INSTALL_PATH}/${binFile}"
                ok "Removed ${INSTALL_PATH}/${binFile}"
                removed=1
            fi
        done
    fi
    if [ "${removed}" = "0" ]; then
        info "No Caracal binaries found in ${INSTALL_PATH}"
    fi
}

if [ "${UNINSTALL}" = "1" ]; then
    uninstall
    exit 0
fi

require() {
    command -v "$1" >/dev/null 2>&1 || err "missing required command: $1"
}

require uname
require mkdir
require chmod
require tar

if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL "$1" -o "$2"; }
    fetchAsset() {
        if [ "${useProgress}" = "1" ]; then
            curl -fL --progress-bar "$1" -o "$2"
        else
            curl -fsSL "$1" -o "$2"
        fi
    }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -qO "$2" "$1"; }
    fetchAsset() { wget -qO "$2" "$1"; }
else
    err "neither curl nor wget is installed"
fi

verifyProvenance() {
    file="$1"
    [ "${VERIFY_PROVENANCE}" = "1" ] || return 0
    if ! command -v gh >/dev/null 2>&1; then
        [ "${REQUIRE_PROVENANCE}" = "1" ] && err "gh is required for provenance verification"
        warn "gh not found; skipping provenance verification for ${file##*/}"
        return 0
    fi
    gh attestation verify "${file}" --repo "${REPO}" >/dev/null \
        || err "provenance verification failed for ${file}"
    ok "Provenance verified: ${file##*/}"
}

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
        [ "${arch}" = arm64 ] && err "Windows arm64 binaries are not published; use install-console.ps1 on Windows"
        require unzip
        ;;
    *) err "unsupported OS: ${os}" ;;
esac

tmp="$(mktemp -d)"
backup="${tmp}/backup"
stage="${tmp}/stage"
committed=0
installedFiles=" "
mkdir -p "${backup}" "${stage}"
cleanup() {
    if [ "${committed}" != "1" ]; then
        for binFile in caracal caracal.exe caracal-console caracal-console.exe; do
            if [ -e "${backup}/${binFile}" ] || [ -L "${backup}/${binFile}" ]; then
                mv -f "${backup}/${binFile}" "${INSTALL_PATH}/${binFile}" 2>/dev/null || true
            elif [ "${installedFiles#* ${binFile} }" != "${installedFiles}" ]; then
                rm -f "${INSTALL_PATH}/${binFile}" 2>/dev/null || true
            fi
        done
    fi
    rm -rf "${tmp}"
}
trap cleanup EXIT

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

section "Caracal Console Installer"
printf '  Release:     %s\n' "${tag}"
printf '  Platform:    %s-%s\n' "${os}" "${arch}"
printf '  Install dir: %s\n' "${INSTALL_DIR}"
[ -n "${DESTDIR_VALUE}" ] && printf '  Staging root: %s\n' "${DESTDIR_VALUE}"
if [ "${REQUIRE_PROVENANCE}" = "1" ]; then
    printf '  Provenance:  required\n'
elif [ "${VERIFY_PROVENANCE}" = "1" ]; then
    printf '  Provenance:  verify when available\n'
else
    printf '  Provenance:  disabled\n'
fi
printf '\n'

step "Downloading release manifest"
fetch "${base}/SHA256SUMS" "${tmp}/SHA256SUMS" || err "failed to download SHA256SUMS"

stageArchive() {
    kind="$1"
    binName="$2"
    archive="caracal-${kind}-${os}-${arch}-${tag}.${ext}"
    expected="$(awk -v n="${archive}" '$2 == n || $2 == "*"n {print $1}' "${tmp}/SHA256SUMS")"
    [ -n "${expected}" ] || err "no checksum for ${archive} in SHA256SUMS"

    step "Downloading ${archive}"
    fetchAsset "${base}/${archive}" "${tmp}/${archive}" || err "failed to download ${archive}"
    actual="$(sha "${tmp}/${archive}")"
    [ "${expected}" = "${actual}" ] || err "checksum mismatch for ${archive}: expected ${expected}, got ${actual}"
    ok "Checksum verified: ${archive}"
    verifyProvenance "${tmp}/${archive}"

    extractDir="${tmp}/extract-${kind}"
    mkdir -p "${extractDir}"
    case "${ext}" in
        tar.gz) tar -xzf "${tmp}/${archive}" -C "${extractDir}" ;;
        zip) unzip -q -o "${tmp}/${archive}" -d "${extractDir}" ;;
    esac

    binFile="${binName}"
    [ "${os}" = windows ] && binFile="${binName}.exe"
    [ -f "${extractDir}/${binFile}" ] || err "expected ${binFile} inside ${archive}, not found"

    mv "${extractDir}/${binFile}" "${stage}/${binFile}"
    chmod +x "${stage}/${binFile}"
}

hasArchive() {
    archive="caracal-${1}-${os}-${arch}-${tag}.${ext}"
    awk -v n="${archive}" '$2 == n || $2 == "*"n {found=1} END {exit found ? 0 : 1}' "${tmp}/SHA256SUMS"
}

mkdir -p "${INSTALL_PATH}"
installedRuntime=0
if hasArchive runtime; then
    installedRuntime=1
    stageArchive runtime caracal
fi
stageArchive console caracal-console

installStaged() {
    binFile="$1"
    src="${stage}/${binFile}"
    dest="${INSTALL_PATH}/${binFile}"
    [ -f "${src}" ] || err "staged binary missing: ${binFile}"
    if [ -e "${dest}" ] || [ -L "${dest}" ]; then
        mv -f "${dest}" "${backup}/${binFile}"
    fi
    mv "${src}" "${dest}"
    installedFiles="${installedFiles}${binFile} "
    chmod +x "${dest}"
    ok "Installed ${dest}"
}

[ "${installedRuntime}" = "1" ] && installStaged "$([ "${os}" = windows ] && printf 'caracal.exe' || printf 'caracal')"
installStaged "$([ "${os}" = windows ] && printf 'caracal-console.exe' || printf 'caracal-console')"
committed=1

if [ -z "${DESTDIR_VALUE}" ]; then
    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*) ;;
        *) info "Add ${INSTALL_DIR} to PATH, for example: export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
    esac
fi

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
        warn "${shadow} appears earlier in PATH than ${INSTALL_DIR}"
        warn "Remove it to use the installed binary: rm \"${shadow}\""
    fi
}

if [ -z "${DESTDIR_VALUE}" ]; then
    [ "${installedRuntime}" = "1" ] && checkShadow caracal
    checkShadow caracal-console
fi

case "${tag}" in
    *-rc.*) mode=rc ;;
    *) mode=stable ;;
esac
ok "Caracal Console is installed"
section "Next steps"
printf '  Release: %s (%s)\n' "${tag}" "${mode}"
printf '  Refresh shell cache: hash -r\n'
[ "${installedRuntime}" = "1" ] && printf '  Launch through runtime: caracal console\n'
printf '  Launch directly: caracal-console\n'
section "Uninstall"
printf '  install-console.sh --install-dir %s --uninstall\n' "${INSTALL_DIR}"
