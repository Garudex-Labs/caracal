#!/bin/sh
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Writes the runtime Redis config from REDIS_PASSWORD and REDIS_MAXMEMORY into
# a private tmpfs path, launches redis-server, provisions the Caracal streams
# and consumer groups once the server accepts connections, and waits on the
# server PID so the container's lifetime tracks redis itself.

set -eu

baseConf="/etc/caracal/redis.conf"
runConf="/run/caracal/redis.conf"
readyMark="/run/caracal/provisioned"

mkdir -p /run/caracal
umask 0077
cp "${baseConf}" "${runConf}"

if [ -n "${REDIS_PASSWORD:-}" ]; then
    printf 'requirepass %s\n' "${REDIS_PASSWORD}" >> "${runConf}"
fi

if [ -n "${REDIS_MAXMEMORY:-}" ]; then
    printf 'maxmemory %s\n' "${REDIS_MAXMEMORY}" >> "${runConf}"
fi

rm -f "${readyMark}"
redis-server "${runConf}" "$@" &
serverPid=$!

ping() {
    if [ -n "${REDIS_PASSWORD:-}" ]; then
        redis-cli -h 127.0.0.1 -p 6379 -a "${REDIS_PASSWORD}" --no-auth-warning PING 2>/dev/null
    else
        redis-cli -h 127.0.0.1 -p 6379 PING 2>/dev/null
    fi
}

tries=0
until [ "$(ping)" = "PONG" ]; do
    tries=$((tries + 1))
    if [ "${tries}" -gt 100 ]; then
        echo "redis did not become ready" >&2
        kill "${serverPid}" 2>/dev/null || true
        exit 1
    fi
    sleep 0.2
done

REDIS_HOST=127.0.0.1 REDIS_PORT=6379 /usr/local/bin/caracal-provision-streams
touch "${readyMark}"

wait "${serverPid}"
