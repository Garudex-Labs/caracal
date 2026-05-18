#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Publishes all @caracalai/* npm packages from a local machine using a manually entered npm token, skipping versions already on the registry.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/style.sh
. "scripts/lib/style.sh"
# shellcheck source=lib/select.sh
. "scripts/lib/select.sh"

packages=(
    packages/core/ts
    packages/oauth/ts
    packages/admin/ts
    packages/identity/ts
    packages/revocation/ts
    packages/sdk/ts
    packages/transport/mcp/ts
    packages/transport/a2a/ts
    packages/connectors/express/ts
    packages/connectors/fastmcp/ts
    packages/connectors/postgres/ts
    packages/connectors/redis/ts
)

pickItems "${packages[@]}"
if [[ ${#PICKED[@]} -eq 0 ]]; then
    say_warn "publishNpm: no packages selected; nothing to do"
    exit 0
fi
packages=("${PICKED[@]}")
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

say_header "publishNpm: publishing"
for d in "${packages[@]}"; do
    name="$(jq -r .name "$d/package.json")"
    ver="$(jq -r .version "$d/package.json")"
    if [[ "$ver" == *"-dev."* || "$ver" == *"+dev."* || "$ver" == *"-rc.sha"* ]]; then
        say_error "refusing to publish dev/prerelease version: ${name}@${ver}"
        exit 1
    fi
    if npm view "${name}@${ver}" version >/dev/null 2>&1; then
        say_warn "skip ${name}@${ver} (already published)"
        continue
    fi
    say_step "publishing ${name}@${ver}"
    while true; do
        otp_args=()
        [[ -n "$NPM_OTP" ]] && otp_args=(--otp "$NPM_OTP")
        if ( cd "$d" && npm publish --access public "${otp_args[@]}" ); then
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
