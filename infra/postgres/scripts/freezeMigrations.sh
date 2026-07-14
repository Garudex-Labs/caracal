#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Freezes the migration set at a stable release by regenerating released.sha256.

# Run once when a stable minor or major release ships: every migration file in
# the directory becomes part of the released set, so validateMigrations.sh
# rejects any later edit to it and admits exactly one new up/down pair for the
# next release line.

set -euo pipefail

MIGRATIONS_DIR="${MIGRATIONS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../migrations" && pwd)}"

cd "${MIGRATIONS_DIR}"
find . -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort | xargs sha256sum > released.sha256
echo "froze $(wc -l < released.sha256) migration file(s) into ${MIGRATIONS_DIR}/released.sha256"
