#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Generates per-environment secret files for compose-mounted Docker secrets.

set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)/files"
mkdir -p "${dir}"
chmod 0700 "${dir}"

writeOnce() {
    name="$1"
    bytes="$2"
    path="${dir}/${name}"
    if [ -s "${path}" ]; then
        echo "skip ${name} (exists)"
        return
    fi
    umask 0177
    openssl rand -hex "${bytes}" > "${path}"
    chmod 0400 "${path}"
    echo "wrote ${name}"
}

writeOnce postgresPassword 24
writeOnce redisPassword    24
writeOnce caracalAdminToken 32
writeOnce zoneKek 32
writeOnce auditHmacKey 32
writeOnce streamsHmacKey 32

echo
echo "secret files in ${dir}"
echo "they are gitignored; never commit"
