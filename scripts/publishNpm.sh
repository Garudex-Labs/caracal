#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Publishes all @caracalai/* npm packages from a local machine using a manually entered npm token, skipping versions already on the registry.

set -euo pipefail

cd "$(dirname "$0")/.."

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

if [[ -z "${NPM_TOKEN:-}" ]]; then
    read -r -s -p "npm token (granular, with publish access to @caracalai): " NPM_TOKEN
    echo
fi
if [[ -z "$NPM_TOKEN" ]]; then
    echo "publishNpm: NPM_TOKEN is required" >&2
    exit 1
fi

npmrc="$(mktemp)"
cleanup() {
    rm -f "$npmrc"
    unset NPM_TOKEN
}
trap cleanup EXIT

echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > "$npmrc"
export NPM_CONFIG_USERCONFIG="$npmrc"

echo "publishNpm: verifying token"
npm whoami

echo "publishNpm: building TypeScript packages"
pnpm install --frozen-lockfile --prefer-offline
pnpm run build:typescript

for d in "${packages[@]}"; do
    name="$(jq -r .name "$d/package.json")"
    ver="$(jq -r .version "$d/package.json")"
    if npm view "${name}@${ver}" version >/dev/null 2>&1; then
        echo "publishNpm: skip ${name}@${ver} (already published)"
        continue
    fi
    echo "publishNpm: publishing ${name}@${ver}"
    ( cd "$d" && npm publish --access public )
done

echo "publishNpm: done"
