#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Publishes modified @caracalai/* npm packages to npm, using the rc dist-tag for rc and latest for stable.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/style.sh
. "scripts/lib/style.sh"
# shellcheck source=lib/select.sh
. "scripts/lib/select.sh"

mode="changed"
base_ref=""
head_ref="HEAD"
select=0

usage() {
    cat <<EOF
Usage: scripts/publishNpm.sh [--all] [--select] [--base REF] [--head REF]

  --all       Include every publishable npm package.
  --select    Interactively narrow the detected package list.
  --base REF  Diff base ref. Defaults to the latest reachable release tag before --head.
  --head REF  Diff head ref. Defaults to HEAD.
              Use --all for an intentional full-package publish.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --all) mode="all"; shift ;;
        --select) select=1; shift ;;
        --base) [[ $# -ge 2 ]] || { say_error "publishNpm: --base requires a ref"; exit 2; }; base_ref="$2"; shift 2 ;;
        --head) [[ $# -ge 2 ]] || { say_error "publishNpm: --head requires a ref"; exit 2; }; head_ref="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) say_error "publishNpm: unknown arg: $1"; usage; exit 2 ;;
    esac
done

detect_args=(--ecosystem npm --format paths --head "$head_ref")
if [[ "$mode" == "all" ]]; then
    detect_args+=(--all)
elif [[ -n "$base_ref" ]]; then
    detect_args+=(--base "$base_ref")
fi

mapfile -t packages < <(node scripts/detectChangedPackages.mjs "${detect_args[@]}")

if [[ ${#packages[@]} -eq 0 ]]; then
    say_warn "publishNpm: no packages selected; nothing to do"
    exit 0
fi

if [[ "$select" == "1" ]]; then
    pickItems "${packages[@]}"
    if [[ ${#PICKED[@]} -eq 0 ]]; then
        say_warn "publishNpm: no packages selected; nothing to do"
        exit 0
    fi
    packages=("${PICKED[@]}")
fi

say_info "publishNpm: ${#packages[@]} package(s) selected"

if [[ -z "${NPM_TOKEN:-}" ]]; then
    read -r -s -p "$(printf '%snpm token (granular, with publish access to @caracalai):%s ' "${C_PROMPT}" "${C_RESET}")" NPM_TOKEN
    echo
fi
if [[ -z "$NPM_TOKEN" ]]; then
    say_error "publishNpm: NPM_TOKEN is required"
    exit 1
fi

npmrc="$(mktemp)"
cleanup() {
    rm -f "$npmrc"
    unset NPM_TOKEN NPM_OTP
}
trap cleanup EXIT

echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > "$npmrc"
export NPM_CONFIG_USERCONFIG="$npmrc"

say_step "publishNpm: verifying token"
npm whoami

if [[ -z "${NPM_OTP:-}" ]]; then
    read -r -p "$(printf '%snpm 2FA OTP (leave empty if the token bypasses 2FA):%s ' "${C_PROMPT}" "${C_RESET}")" NPM_OTP
fi

say_step "publishNpm: building TypeScript packages"
pnpm install --frozen-lockfile --prefer-offline
pnpm run build:typescript

say_header "publishNpm: publishing stable/latest or rc packages"
for d in "${packages[@]}"; do
    name="$(jq -r .name "$d/package.json")"
    ver="$(jq -r .version "$d/package.json")"
    if [[ "$ver" == *"dev.sha"* || "$ver" == *"dev."* ]]; then
        say_error "refusing to publish dev-stamped version: ${name}@${ver}"
        exit 1
    fi
    dist_tag="latest"
    [[ "$ver" == *"-rc."* ]] && dist_tag="rc"
    if npm view "${name}@${ver}" version >/dev/null 2>&1; then
        say_warn "skip ${name}@${ver} (already published)"
        continue
    fi
    say_step "publishing ${name}@${ver} with ${dist_tag} dist-tag"
    while true; do
        otp_args=()
        [[ -n "$NPM_OTP" ]] && otp_args=(--otp "$NPM_OTP")
        if ( cd "$d" && npm publish --access public --tag "$dist_tag" "${otp_args[@]}" ); then
            say_success "${name}@${ver}"
            break
        fi
        read -r -p "$(printf '%spublish failed (OTP expired?); enter a new OTP or empty to abort:%s ' "${C_PROMPT}" "${C_RESET}")" NPM_OTP
        [[ -z "$NPM_OTP" ]] && { say_error "publishNpm: aborted"; exit 1; }
    done
done

say_step "publishNpm: verifying latest versions on npm"
for d in "${packages[@]}"; do
    name="$(jq -r .name "$d/package.json")"
    latest="$(curl -fsSL "https://registry.npmjs.org/${name}" 2>/dev/null | jq -r '.["dist-tags"].latest // "unknown"')"
    printf '  %s%s%s  latest=%s\n' "${C_LABEL}" "${name}" "${C_RESET}" "${latest}"
done

say_success "publishNpm: done"
