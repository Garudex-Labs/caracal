#!/bin/sh
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Writes the runtime Redis config from REDIS_PASSWORD and REDIS_MAXMEMORY env
# vars into a private tmpfs path so the password never appears in argv or in
# the published image. Execs redis-server in the foreground.

set -eu

baseConf="/etc/caracal/redis.conf"
runConf="/run/caracal/redis.conf"

mkdir -p /run/caracal
umask 0077
cp "${baseConf}" "${runConf}"

if [ -n "${REDIS_PASSWORD:-}" ]; then
    printf 'requirepass %s\n' "${REDIS_PASSWORD}" >> "${runConf}"
fi

if [ -n "${REDIS_MAXMEMORY:-}" ]; then
    printf 'maxmemory %s\n' "${REDIS_MAXMEMORY}" >> "${runConf}"
fi

exec redis-server "${runConf}" "$@"