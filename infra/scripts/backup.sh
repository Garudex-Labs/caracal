#!/bin/sh
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Online backup of a self-hosted Caracal compose stack. Produces a single
# timestamped tar.gz bundle containing Postgres role and database dumps, the
# Redis append-only dataset, and the sts/gateway replay-protection state.
# Runs against the live stack without downtime; Postgres dumps are
# transaction-consistent snapshots and the Redis copy follows a completed
# AOF rewrite. Secrets are deliberately excluded: back up the secrets
# directory through your secret-management workflow, not alongside data.
#
# Usage: backup.sh
#   CARACAL_COMPOSE_PROJECT  compose project name (default: caracal)
#   CARACAL_BACKUP_DIR       output directory (default: ./backups)
#   CARACAL_BACKUP_RETAIN    bundles to keep, oldest pruned (default: 7)
#   POSTGRES_USER            Postgres superuser (default: caracal)

set -eu

project="${CARACAL_COMPOSE_PROJECT:-caracal}"
outDir="${CARACAL_BACKUP_DIR:-./backups}"
retain="${CARACAL_BACKUP_RETAIN:-7}"
pgUser="${POSTGRES_USER:-caracal}"

command -v docker >/dev/null 2>&1 || { echo "error: docker is required" >&2; exit 1; }

resolveContainer() {
    docker ps --filter "label=com.docker.compose.project=${project}" \
        --filter "label=com.docker.compose.service=$1" --format '{{.ID}}' | head -n 1
}

requireContainer() {
    ctr="$(resolveContainer "$1")"
    if [ -z "${ctr}" ]; then
        echo "error: no running '$1' container in compose project '${project}'" >&2
        exit 1
    fi
    echo "${ctr}"
}

redisCli() {
    docker exec "${redisCtr}" sh -c "REDISCLI_AUTH=\"\$(cat /run/secrets/redisPassword)\" redis-cli --no-auth-warning $*"
}

postgresCtr="$(requireContainer postgres)"
redisCtr="$(requireContainer redis)"
stsCtr="$(resolveContainer sts)"
gatewayCtr="$(resolveContainer gateway)"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
bundleName="caracalBackup-${stamp}"
workDir="$(mktemp -d)"
trap 'rm -rf "${workDir}"' EXIT
bundleDir="${workDir}/${bundleName}"
mkdir -p "${bundleDir}/postgres" "${bundleDir}/redis" "${bundleDir}/replay"

echo "==> Postgres: dumping roles"
docker exec "${postgresCtr}" pg_dumpall -U "${pgUser}" --globals-only >"${bundleDir}/postgres/globals.sql"

echo "==> Postgres: dumping databases"
databases="$(docker exec "${postgresCtr}" psql -U "${pgUser}" -d postgres -At \
    -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'")"
for db in ${databases}; do
    echo "    pg_dump ${db}"
    docker exec "${postgresCtr}" pg_dump -U "${pgUser}" --format=custom "${db}" >"${bundleDir}/postgres/${db}.dump"
done

echo "==> Redis: rewriting AOF for a compact consistent copy"
redisCli BGREWRITEAOF >/dev/null
elapsed=0
while [ "$(redisCli INFO persistence | tr -d '\r' | sed -n 's/^aof_rewrite_in_progress://p')" = "1" ]; do
    if [ "${elapsed}" -ge 300 ]; then
        echo "error: Redis AOF rewrite did not finish within 300s" >&2
        exit 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done
docker cp -q "${redisCtr}:/data/appendonlydir" "${bundleDir}/redis/appendonlydir"

# Replay-protection state is small and self-rebuilding, but restoring it keeps
# one-time-token replay windows closed across a disaster recovery.
if [ -n "${stsCtr}" ]; then
    echo "==> Replay state: sts"
    docker cp -q "${stsCtr}:/var/lib/caracal" "${bundleDir}/replay/sts"
fi
if [ -n "${gatewayCtr}" ]; then
    echo "==> Replay state: gateway"
    docker cp -q "${gatewayCtr}:/var/lib/caracal" "${bundleDir}/replay/gateway"
fi

{
    echo "version: 1"
    echo "createdAt: ${stamp}"
    echo "project: ${project}"
    echo "databases: ${databases}" | tr '\n' ' '
    echo ""
} >"${bundleDir}/manifest.txt"

mkdir -p "${outDir}"
bundlePath="${outDir}/${bundleName}.tar.gz"
tar -C "${workDir}" -czf "${bundlePath}" "${bundleName}"

# Bundle stamps are UTC and lexicographically ordered, so the ascending glob
# walks oldest-first and pruning the leading excess keeps the newest bundles.
total=0
for f in "${outDir}"/caracalBackup-*.tar.gz; do
    [ -e "${f}" ] || continue
    total=$((total + 1))
done
excess=$((total - retain))
for f in "${outDir}"/caracalBackup-*.tar.gz; do
    [ -e "${f}" ] || continue
    if [ "${excess}" -gt 0 ]; then
        echo "==> Pruning ${f}"
        rm -f "${f}"
        excess=$((excess - 1))
    fi
done

echo "backup ok: ${bundlePath}"
echo "note: secrets are NOT included; back up the secrets directory separately."
