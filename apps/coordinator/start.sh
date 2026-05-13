#!/bin/sh
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Starts the Go relay and Node coordinator side-by-side and forwards SIGTERM/SIGINT
# to both children. Exits as soon as either child exits so the container does not
# linger after a partial failure. Designed for /bin/sh (BusyBox ash) under tini.

set -u

/relay &
relayPid=$!
node /app/dist/main.js &
nodePid=$!

shutdown() {
    kill -TERM "${relayPid}" "${nodePid}" 2>/dev/null || true
}
trap shutdown TERM INT HUP

while kill -0 "${relayPid}" 2>/dev/null && kill -0 "${nodePid}" 2>/dev/null; do
    sleep 1
done

shutdown
wait "${relayPid}" 2>/dev/null
relayStatus=$?
wait "${nodePid}" 2>/dev/null
nodeStatus=$?

if [ "${nodeStatus}" -ne 0 ]; then
    exit "${nodeStatus}"
fi
exit "${relayStatus}"
