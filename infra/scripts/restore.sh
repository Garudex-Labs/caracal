#!/bin/sh
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Disaster-recovery restore of a self-hosted Caracal compose stack from a
# bundle produced by backup.sh. Stops application services, recreates every
# Postgres database from its dump, replaces the Redis dataset and the
# sts/gateway replay-protection state, then restarts the stack. Postgres and
# Redis containers must be running; secrets must already be in place because
# bundles never contain them.
#
# Usage: CARACAL_RESTORE_CONFIRM=yes restore.sh <bundle.tar.gz>
#   CARACAL_COMPOSE_PROJECT  compose project name (default: caracal)
#   POSTGRES_USER            Postgres superuser (default: caracal)

set -eu
umask 077

bundle="${1:-}"
project="${CARACAL_COMPOSE_PROJECT:-caracal}"
pgUser="${POSTGRES_USER:-caracal}"

if [ -z "${bundle}" ] || [ ! -f "${bundle}" ]; then
    echo "usage: CARACAL_RESTORE_CONFIRM=yes $0 <bundle.tar.gz>" >&2
    exit 1
fi
if [ "${CARACAL_RESTORE_CONFIRM:-}" != "yes" ]; then
    echo "error: restore replaces all databases and state. Set CARACAL_RESTORE_CONFIRM=yes to proceed." >&2
    exit 1
fi
command -v docker >/dev/null 2>&1 || { echo "error: docker is required" >&2; exit 1; }

resolveContainer() {
    docker ps -a --filter "label=com.docker.compose.project=${project}" \
        --filter "label=com.docker.compose.service=$1" --format '{{.ID}}' | head -n 1
}

requireContainer() {
    ctr="$(resolveContainer "$1")"
    if [ -z "${ctr}" ]; then
        echo "error: no '$1' container in compose project '${project}'" >&2
        exit 1
    fi
    echo "${ctr}"
}

postgresCtr="$(requireContainer postgres)"
redisCtr="$(requireContainer redis)"
# The redis image ships a shell and is guaranteed present on the node, so it
# doubles as the helper for volume permission fixes on shell-less containers.
# The tag may have moved or been removed since this container started. Use the
# actual local image ID and never pull a different helper during recovery.
redisVolume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "${redisCtr}")"
[ -n "${redisVolume}" ] || { echo "error: Redis /data must be a named volume" >&2; exit 1; }
helperImage="$(docker inspect -f '{{.Image}}' "${redisCtr}")"

workDir="$(mktemp -d)"
trap 'rm -rf "${workDir}"' EXIT
tar -C "${workDir}" -xzf "${bundle}"
bundleDir="$(find "${workDir}" -mindepth 1 -maxdepth 1 -type d -name 'caracalBackup-*' | head -n 1)"
if [ -z "${bundleDir}" ] || [ ! -f "${bundleDir}/manifest.txt" ]; then
    echo "error: bundle does not contain a caracalBackup-* directory with a manifest" >&2
    exit 1
fi
grep -q '^version: 1$' "${bundleDir}/manifest.txt" || { echo "error: unsupported bundle version" >&2; exit 1; }

echo "==> Stopping application services"
for svc in web coordinator audit gateway api sts; do
    ctr="$(resolveContainer "${svc}")"
    if [ -n "${ctr}" ]; then
        echo "    stop ${svc}"
        docker stop "${ctr}" >/dev/null
    fi
done

echo "==> Postgres: restoring roles"
# Existing-role CREATE errors are expected on a restore into an initialized
# store; psql continues to the ALTERs. Connection or client failures must abort.
docker exec -i "${postgresCtr}" psql -U "${pgUser}" -d postgres -q -f - <"${bundleDir}/postgres/globals.sql" >"${workDir}/roles.log" 2>&1 || {
    echo "error: could not restore PostgreSQL roles" >&2
    exit 1
}

echo "==> Postgres: recreating databases"
for dumpFile in "${bundleDir}"/postgres/*.dump; do
    [ -f "${dumpFile}" ] || continue
    db="$(basename "${dumpFile}" .dump)"
    quotedDb="$(printf '%s' "${db}" | sed 's/"/""/g')"
    echo "    restore ${db}"
    docker exec "${postgresCtr}" psql -U "${pgUser}" -d postgres -v ON_ERROR_STOP=1 \
        -c "DROP DATABASE IF EXISTS \"${quotedDb}\" WITH (FORCE)" >/dev/null
    docker exec "${postgresCtr}" psql -U "${pgUser}" -d postgres -v ON_ERROR_STOP=1 \
        -c "CREATE DATABASE \"${quotedDb}\"" >/dev/null
    docker exec -i "${postgresCtr}" pg_restore -U "${pgUser}" --exit-on-error -d "${db}" <"${dumpFile}"
done

echo "==> Redis: replacing dataset"
docker stop "${redisCtr}" >/dev/null
docker run --rm --pull never --user 0:0 --network none --read-only --security-opt no-new-privileges:true \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --mount "type=volume,source=${redisVolume},target=/data" --entrypoint /bin/sh "${helperImage}" \
    -c 'rm -rf /data/appendonlydir /data/dump.rdb'
docker cp -q "${bundleDir}/redis/appendonlydir" "${redisCtr}:/data/appendonlydir"
docker run --rm --pull never --user 0:0 --network none --read-only --security-opt no-new-privileges:true \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --mount "type=volume,source=${redisVolume},target=/data" --entrypoint /bin/sh "${helperImage}" \
    -c 'chown -R redis:redis /data/appendonlydir'
docker start "${redisCtr}" >/dev/null

restoreReplay() {
    svc="$1"
    ctr="$(resolveContainer "${svc}")"
    if [ -d "${bundleDir}/replay/${svc}" ] && [ -n "${ctr}" ]; then
        echo "==> Replay state: ${svc}"
        docker cp -q "${bundleDir}/replay/${svc}/." "${ctr}:/var/lib/caracal/"
        replayVolume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/caracal"}}{{.Name}}{{end}}{{end}}' "${ctr}")"
        [ -n "${replayVolume}" ] || { echo "error: ${svc} replay state must be a named volume" >&2; exit 1; }
        docker run --rm --pull never --user 0:0 --network none --read-only --security-opt no-new-privileges:true \
            --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --mount "type=volume,source=${replayVolume},target=/var/lib/caracal" --entrypoint /bin/sh "${helperImage}" \
            -c 'chown -R 65532:65532 /var/lib/caracal'
    fi
}
restoreReplay sts
restoreReplay gateway

echo "==> Restarting application services"
for svc in sts api gateway audit coordinator web; do
    ctr="$(resolveContainer "${svc}")"
    if [ -n "${ctr}" ]; then
        echo "    start ${svc}"
        docker start "${ctr}" >/dev/null
    fi
done

echo "restore ok: verify with infra/scripts/smokeTest.sh once healthchecks settle"
