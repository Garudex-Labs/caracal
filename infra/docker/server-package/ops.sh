#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0
#
# Caracal operator tool for self-hosted deployments.
#
# This script ships with the server package and is the operator-side
# interface for deployment lifecycle, upgrades, backups, and teardown.
# It is intentionally NOT part of the customer CLI: customers interact
# with Caracal through `caracal` (API client) and the web UI only, while
# the operator team manages the infrastructure with this tool from the
# deployment directory.

set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE=.env
COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.observability.yml ] && [ "${CARACAL_OBSERVABILITY:-0}" = "1" ] && \
    COMPOSE+=(-f docker-compose.observability.yml)
BACKUP_DIR=${CARACAL_BACKUP_DIR:-./backups}

die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

[ -f docker-compose.yml ] || die "run from the deployment directory (docker-compose.yml not found)"
[ -f "$ENV_FILE" ] || die ".env not found; run ./setup.sh first"

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1; }

set_env_value() {
    if grep -q "^$1=" "$ENV_FILE"; then
        sed -i.bak "s|^$1=.*|$1=$2|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    else
        printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
    fi
}

confirm() {
    [ "${ASSUME_YES:-0}" = "1" ] && return 0
    printf '%s [y/N] ' "$1"
    read -r answer
    [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "aborted"
}

health_url() {
    local bind port
    bind=$(env_value CARACAL_BIND_ADDRESS); bind=${bind:-127.0.0.1}
    port=$(env_value API_HOST_PORT); port=${port:-80}
    printf 'http://%s:%s/health' "$bind" "$port"
}

wait_healthy() {
    local url deadline
    url=$(health_url)
    deadline=$(( $(date +%s) + 180 ))
    info "waiting for $url"
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if curl -fsS -o /dev/null "$url" 2>/dev/null; then
            info "API is healthy"
            return 0
        fi
        sleep 2
    done
    return 1
}

backup_postgres() {
    local user stamp target
    user=$(env_value POSTGRES_USER); user=${user:-postgres}
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    target="$BACKUP_DIR/postgres-$stamp.sql.gz"
    mkdir -p "$BACKUP_DIR"
    info "backing up PostgreSQL to $target"
    "${COMPOSE[@]}" exec -T caracal-db pg_dumpall -U "$user" | gzip >"$target"
    printf '%s\n' "$target"
}

latest_backup() { ls -1t "$BACKUP_DIR"/postgres-*.sql.gz 2>/dev/null | head -n1; }

cmd_start()   { "${COMPOSE[@]}" up -d --wait --wait-timeout 300; "${COMPOSE[@]}" restart caracal-lb; wait_healthy || die "stack started but the API is not healthy"; }
cmd_stop()    { "${COMPOSE[@]}" stop; info "stack stopped"; }
cmd_restart() { "${COMPOSE[@]}" restart; "${COMPOSE[@]}" restart caracal-lb; wait_healthy || die "stack restarted but the API is not healthy"; }
cmd_status()  { "${COMPOSE[@]}" ps; curl -fsS -o /dev/null "$(health_url)" 2>/dev/null && info "API is healthy" || info "API health check failed"; }
cmd_logs()    { "${COMPOSE[@]}" logs --tail "${LINES:-100}" "$@"; }
cmd_backup()  { backup_postgres >/dev/null; }

cmd_upgrade() {
    local target current backup
    target=${1:-latest}
    current=$(env_value CARACAL_VERSION); current=${current:-latest}
    info "upgrading $current -> $target"
    backup=$(backup_postgres)
    set_env_value CARACAL_VERSION "$target"
    if ! "${COMPOSE[@]}" pull; then
        set_env_value CARACAL_VERSION "$current"
        die "image pull failed; version restored to $current"
    fi
    "${COMPOSE[@]}" up -d
    "${COMPOSE[@]}" restart caracal-lb
    if ! wait_healthy; then
        info "health check failed; reverting to $current (backup kept: $backup)"
        set_env_value CARACAL_VERSION "$current"
        "${COMPOSE[@]}" up -d
        "${COMPOSE[@]}" restart caracal-lb
        die "upgrade rolled back to $current"
    fi
    info "upgrade complete: $target (backup: $backup)"
}

cmd_rollback() {
    local backup user
    backup=${1:-$(latest_backup)}
    [ -n "$backup" ] && [ -f "$backup" ] || die "no backup found in $BACKUP_DIR"
    user=$(env_value POSTGRES_USER); user=${user:-postgres}
    confirm "Restore PostgreSQL from $backup? Current data will be replaced."
    info "restoring $backup"
    gunzip -c "$backup" | "${COMPOSE[@]}" exec -T caracal-db psql -U "$user" -d postgres
    "${COMPOSE[@]}" restart
    wait_healthy || die "restore finished but the API is not healthy"
    info "rollback complete (ClickHouse telemetry is not restored by backups)"
}

cmd_reset() {
    confirm "Delete all containers and data volumes?"
    "${COMPOSE[@]}" down -v --remove-orphans
    info "stack reset; containers and volumes removed"
}

cmd_purge() {
    case "${1:-}" in
        containers)
            confirm "Remove containers and networks? Images and data are kept."
            "${COMPOSE[@]}" down --remove-orphans ;;
        stack)
            confirm "Remove containers, networks, and images? Database volumes are kept."
            "${COMPOSE[@]}" down --remove-orphans --rmi all ;;
        all)
            confirm "Remove EVERYTHING, including database volumes?"
            "${COMPOSE[@]}" down -v --remove-orphans --rmi all ;;
        *) die "usage: ops.sh purge <containers|stack|all>" ;;
    esac
    info "purge complete"
}

usage() {
    cat <<'EOF'
Caracal operator tool (self-hosted deployments)

Usage: ops.sh <command> [args]

  start                    start the stack and wait for API health
  stop                     stop the stack
  restart                  restart the stack and wait for API health
  status                   show services and API health
  logs [service]           tail logs (LINES=n to change depth)
  backup                   back up PostgreSQL to ./backups
  upgrade [version]        backup, pull, switch CARACAL_VERSION, health-check;
                           reverts the version automatically on failure
  rollback [backup-file]   restore PostgreSQL from a backup (default: latest)
  reset                    remove containers and data volumes
  purge <scope>            containers | stack (adds images) | all (adds volumes)

Set ASSUME_YES=1 to skip confirmations. Data migration between deployments
runs through the admin API (Admin -> Migration in the web UI).
EOF
}

command=${1:-}
[ -n "$command" ] || { usage; exit 1; }
shift || true
case "$command" in
    start|stop|restart|status|logs|backup|upgrade|rollback|reset|purge)
        "cmd_$command" "$@" ;;
    -h|--help|help) usage ;;
    *) usage; die "unknown command: $command" ;;
esac
