#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Builds, publishes, selects, reverts, and cleans production-shaped Caracal prereleases.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/style.sh
. "scripts/lib/style.sh"

if ! command -v node >/dev/null 2>&1; then
    say_error "prerelease: node is required"
    exit 1
fi

node scripts/prerelease.mjs "$@"
