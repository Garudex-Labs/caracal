#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs. All Rights Reserved.
# Caracal, a product of Garudex Labs
# Disposable real stack, not a production deployment. Run from the repository root.
set -euo pipefail
work=${PERF_WORK_DIR:-/tmp/caracal-coordinator-bench}
name=${PERF_CONTAINER_PREFIX:-caracal-coordinator-bench}
pgPort=${PERF_PG_PORT:-45432}
redisPort=${PERF_REDIS_PORT:-46379}
case "${1:-}" in
  init)
    mkdir -p "$work"
    test ! -e "$work/env" || { echo "Existing fixture: use it or choose a fresh PERF_WORK_DIR/PERF_CONTAINER_PREFIX" >&2; exit 1; }
    umask 077
    pw=$(openssl rand -hex 24)
    cat >"$work/env" <<ENV
export PERF_PG_PORT=$pgPort PERF_REDIS_PORT=$redisPort
export DATABASE_URL=postgres://caracalcoordinator:$pw@127.0.0.1:$pgPort/caracal
export PERF_DATABASE_URL=postgres://caracal:$pw@127.0.0.1:$pgPort/caracal
export REDIS_URL=redis://:$pw@127.0.0.1:$redisPort
export CARACAL_MODE=dev HOST=127.0.0.1 LOG_LEVEL=warn
export STS_URL=http://127.0.0.1:8080 ISSUER_URL=http://127.0.0.1:8080
export CARACAL_API_URL=http://127.0.0.1:3000 CARACAL_COORDINATOR_URL=http://127.0.0.1:4000 CARACAL_GATEWAY_URL=http://127.0.0.1:8081
export CARACAL_COORDINATOR_TOKEN=$(openssl rand -hex 32) CARACAL_ADMIN_TOKEN=$(openssl rand -hex 32)
export AGENT_COORDINATOR_SCOPE=agent:lifecycle
export STREAMS_HMAC_KEY=$(openssl rand -hex 32) AUDIT_HMAC_KEY=$(openssl rand -hex 32)
export GATEWAY_STS_HMAC_KEY=$(openssl rand -hex 32) SECRET_STORE_KEK=$(openssl rand -hex 32)
export COORDINATOR_RATE_LIMIT_PER_MIN=10000000 INVOCATION_RATE_LIMIT_PER_MIN=10000000 VERIFY_RATE_LIMIT_PER_MIN=10000000
export API_V1_RATE_LIMIT_PER_MIN=10000000 STS_MINT_RATE_LIMIT_PER_MIN=10000000
export MAX_AGENTS_PER_ZONE=100000 MAX_AGENTS_PER_APP=100000 IDEMPOTENCY_MAX_RECEIPTS_PER_SCOPE=100000
export SERVICE_AGENT_LEASE_SECONDS=3600 OUTBOX_INTERVAL_MS=50 OUTBOX_BATCH_SIZE=500
export PERF_OUTPUT_DIR=$work/profiles
ENV
    docker run -d --name "$name-pg" --label caracal.coordinator.perf=true -e POSTGRES_USER=caracal -e POSTGRES_DB=caracal -e POSTGRES_PASSWORD="$pw" -p 127.0.0.1:$pgPort:5432 postgres:17-alpine -c shared_preload_libraries=pg_stat_statements -c track_io_timing=on
    docker run -d --name "$name-redis" --label caracal.coordinator.perf=true -p 127.0.0.1:$redisPort:6379 redis:7.4-alpine redis-server --requirepass "$pw"
    PGPASSWORD="$pw" PGHOST=127.0.0.1 PGPORT="$pgPort" PGUSER=caracal PGDATABASE=caracal MIGRATIONS_DIR="$PWD/infra/postgres/migrations" \
      CARACAL_API_DB_PASSWORD="$pw" CARACAL_STS_DB_PASSWORD="$pw" CARACAL_GATEWAY_DB_PASSWORD="$pw" CARACAL_AUDIT_DB_PASSWORD="$pw" CARACAL_COORDINATOR_DB_PASSWORD="$pw" \
      sh infra/postgres/scripts/migrate.sh >"$work/migrate.log"
    # Existing baseline grants only SELECT on applications, but FOR SHARE also needs UPDATE.
    # Do not apply this test-only workaround to a production DB or weaken RLS/bypass checks.
    PGPASSWORD="$pw" psql -h 127.0.0.1 -p "$pgPort" -U caracal -d caracal -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION pg_stat_statements; GRANT UPDATE(id) ON applications TO caracalcoordinator;'
    REDIS_PASSWORD="$pw" REDIS_HOST=127.0.0.1 REDIS_PORT="$redisPort" sh infra/redis/provision-streams.sh
    go build -o "$work/sts" ./services/sts/cmd/sts
    go build -o "$work/gateway" ./services/gateway/cmd/gateway
    go build -o "$work/audit" ./services/audit/cmd/audit
    echo "Fixture initialized at $work; run deps and coordinator in separate terminals."
    ;;
  deps)
    source "$work/env"
    pids=()
    trap 'kill "${pids[@]}" 2>/dev/null || true; wait || true' EXIT
    DATABASE_URL=${DATABASE_URL/caracalcoordinator/caracalapi} PORT=3000 node apps/api/dist/main.js >"$work/api.log" 2>&1 & pids+=("$!")
    DATABASE_URL=${DATABASE_URL/caracalcoordinator/caracalsts} PORT=8080 AUDIT_REPLAY_DIR="$work/sts-replay" "$work/sts" >"$work/sts.log" 2>&1 & pids+=("$!")
    DATABASE_URL=${DATABASE_URL/caracalcoordinator/caracalgateway} PORT=8081 AUDIT_REPLAY_DIR="$work/gateway-replay" "$work/gateway" >"$work/gateway.log" 2>&1 & pids+=("$!")
    DATABASE_URL=${DATABASE_URL/caracalcoordinator/caracalaudit} PORT=9090 "$work/audit" >"$work/audit.log" 2>&1 & pids+=("$!")
    wait
    ;;
  coordinator)
    source "$work/env"
    module=${2:-$PWD/apps/coordinator}
    export PORT=4000 PERF_MODULE_ROOT="$module/package.json"
    args=()
    if [[ ${PERF_PROFILE:-1} == 1 ]]; then args+=(--import "$PWD/tests/typescript/performance/coordinator/profile.mjs"); fi
    exec taskset -c "${PERF_CPU:-14}" node "${args[@]}" "$module/dist/main.js"
    ;;
  stop)
    for container in "$name-pg" "$name-redis"; do
      [[ $(docker inspect -f '{{ index .Config.Labels "caracal.coordinator.perf" }}' "$container") == true ]] || { echo "Not an owned benchmark container: $container" >&2; exit 1; }
      docker rm -f "$container"
    done
    ;;
  *) echo "Usage: $0 init|deps|coordinator [frozen-module-dir]|stop" >&2; exit 1 ;;
esac
