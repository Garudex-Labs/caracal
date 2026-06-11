#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Pulls each Caracal container image at its manifest-pinned tag and boots them via docker-compose.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "$HERE/lib/common.sh"

readonly AREA="containers"
readonly REGISTRY="$CARACAL_REGISTRY"
readonly IMAGE_PREFIX="$CARACAL_IMAGE_PREFIX"
readonly REPO_ROOT="$(cd "$HERE/../.." && pwd)"
readonly COMPOSE_SRC="$REPO_ROOT/infra/docker/runtime-compose.yml"

imageRef() {
  printf '%s/%s%s:v%s' "$REGISTRY" "$IMAGE_PREFIX" "$1" "$2"
}

validatePull() {
  local svc="$1" ver="$2"
  matchesOnly "$svc" || return 0
  local img; img="$(imageRef "$svc" "$ver")"
  if runOrEcho docker pull "$img" >/dev/null 2>&1; then
    logFinding "$AREA" "$img" "linux-amd64" "ghcr" "docker" "$SEV_INFO" "$STATUS_PASS" "image pulled" "docker pull $img"
  else
    logFinding "$AREA" "$img" "linux-amd64" "ghcr" "docker" "$SEV_BLOCKER" "$STATUS_FAIL" "docker pull failed" "docker pull $img"
  fi
}

validateStack() {
  matchesOnly "stack" || return 0
  if [[ ! -f "$COMPOSE_SRC" ]]; then
    logFinding "$AREA" "stack" "linux-amd64" "compose" "docker" "$SEV_MAJOR" "$STATUS_WARN" "runtime-compose.yml not found" "ls $COMPOSE_SRC"
    return 0
  fi
  local dir; dir="$(mktemp -d)"
  mkdir -p "$dir/secrets"
  cat >"$dir/stack.env" <<EOF
CARACAL_VERSION=${CARACAL_RELEASE#v}
CARACAL_REGISTRY=${REGISTRY%/}/
POSTGRES_USER=caracal
POSTGRES_DB=caracal
POSTGRES_PASSWORD=5e02824a98a983cf03f4e95ac4cebb610fb1f1e8ed1e92e1
REDIS_PASSWORD=8a26e3a4be1cd14b58be05a8f6e08a6d6a4d2b7a4ed00b71
CARACAL_ADMIN_TOKEN=81329794e124d992bd6179d7261a2f74318c25bf2f7f3f47204c0af4ca861bc5
CARACAL_COORDINATOR_TOKEN=52f2b211731ef7f027f30a90d6079a6bb7b1ed73e2387f256dfd6c9662bc0515
ZONE_KEK=259b234936c7c77c6374f00832532aea384752b1ef45d6a026b24db660738605
AUDIT_HMAC_KEY=af82a881d18d05472b4983db53dfe9c503eb414747c96f4bee5b2bfcf7be5bc9
STREAMS_HMAC_KEY=43bb7cb1013e1050fbc1d5aa72672037d86380c6d93cede6148be2f9c728ee7c
GATEWAY_STS_HMAC_KEY=730de8c006a7792407a41096c59130ab802fa04e9625cd49f031d3e7ef8e14bb
EOF
  cat >"$dir/secrets/postgresPassword" <<'EOF'
5e02824a98a983cf03f4e95ac4cebb610fb1f1e8ed1e92e1
EOF
  cat >"$dir/secrets/redisPassword" <<'EOF'
8a26e3a4be1cd14b58be05a8f6e08a6d6a4d2b7a4ed00b71
EOF
  cat >"$dir/secrets/caracalAdminToken" <<'EOF'
81329794e124d992bd6179d7261a2f74318c25bf2f7f3f47204c0af4ca861bc5
EOF
  cat >"$dir/secrets/caracalCoordinatorToken" <<'EOF'
52f2b211731ef7f027f30a90d6079a6bb7b1ed73e2387f256dfd6c9662bc0515
EOF
  cat >"$dir/secrets/zoneKek" <<'EOF'
259b234936c7c77c6374f00832532aea384752b1ef45d6a026b24db660738605
EOF
  cat >"$dir/secrets/auditHmacKey" <<'EOF'
af82a881d18d05472b4983db53dfe9c503eb414747c96f4bee5b2bfcf7be5bc9
EOF
  cat >"$dir/secrets/streamsHmacKey" <<'EOF'
43bb7cb1013e1050fbc1d5aa72672037d86380c6d93cede6148be2f9c728ee7c
EOF
  cat >"$dir/secrets/gatewayStsHmacKey" <<'EOF'
730de8c006a7792407a41096c59130ab802fa04e9625cd49f031d3e7ef8e14bb
EOF
  cat >"$dir/secrets/databaseUrl" <<'EOF'
postgres://caracal:5e02824a98a983cf03f4e95ac4cebb610fb1f1e8ed1e92e1@postgres:5432/caracal
EOF
  cat >"$dir/secrets/redisUrl" <<'EOF'
redis://:8a26e3a4be1cd14b58be05a8f6e08a6d6a4d2b7a4ed00b71@redis:6379
EOF
  chmod 0444 "$dir"/secrets/*
  REG="$REGISTRY" PREFIX="$IMAGE_PREFIX" SECRETS_DIR="$dir/secrets" "$CARACAL_PYTHON" - "$MANIFEST" "$dir/docker-compose.release.yml" <<'PY'
import json, os, sys
manifest = json.load(open(sys.argv[1]))
out = open(sys.argv[2], "w")
secrets_dir = os.environ["SECRETS_DIR"]
secret_names = [
    "postgresPassword",
    "redisPassword",
    "caracalAdminToken",
    "caracalCoordinatorToken",
    "zoneKek",
    "auditHmacKey",
    "streamsHmacKey",
    "gatewayStsHmacKey",
    "databaseUrl",
    "redisUrl",
]
out.write("secrets:\n")
for name in secret_names:
    out.write(f"  {name}:\n")
    out.write(f"    file: {secrets_dir}/{name}\n")
out.write("services:\n")
for svc, ver in manifest["containers"].items():
    out.write(f"  {svc}:\n")
    out.write(f"    image: {os.environ['REG']}/{os.environ['PREFIX']}{svc}:v{ver}\n")
    out.write("    pull_policy: never\n")
PY
  local i img
  for (( i = 0; i < ${#CONTAINER_NAMES[@]}; i++ )); do
    img="$(imageRef "${CONTAINER_NAMES[$i]}" "${CONTAINER_VERS[$i]}")"
    if ! runOrEcho docker pull "$img" >>"$dir/pull" 2>&1; then
      logFinding "$AREA" "stack" "linux-amd64" "compose" "docker" "$SEV_BLOCKER" "$STATUS_FAIL" "$(head -c 2000 "$dir/pull")" "docker pull $img"
      rm -rf "$dir"
      return 0
    fi
  done
  if ! runOrEcho docker compose --env-file "$dir/stack.env" -f "$COMPOSE_SRC" -f "$dir/docker-compose.release.yml" pull replayVolumeInit >>"$dir/pull" 2>&1; then
    logFinding "$AREA" "stack" "linux-amd64" "compose" "docker" "$SEV_BLOCKER" "$STATUS_FAIL" "$(head -c 2000 "$dir/pull")" "docker compose pull replayVolumeInit"
    rm -rf "$dir"
    return 0
  fi
  if runOrEcho docker compose --env-file "$dir/stack.env" -f "$COMPOSE_SRC" -f "$dir/docker-compose.release.yml" up -d --no-build --pull never >"$dir/up" 2>&1; then
    sleep 5
    logFinding "$AREA" "stack" "linux-amd64" "compose" "docker" "$SEV_INFO" "$STATUS_PASS" "compose up succeeded" "docker compose up -d"
    runOrEcho docker compose --env-file "$dir/stack.env" -f "$COMPOSE_SRC" -f "$dir/docker-compose.release.yml" down -v >/dev/null 2>&1 || true
  else
    logFinding "$AREA" "stack" "linux-amd64" "compose" "docker" "$SEV_BLOCKER" "$STATUS_FAIL" "$(head -c 2000 "$dir/up")" "docker compose up -d"
    runOrEcho docker compose --env-file "$dir/stack.env" -f "$COMPOSE_SRC" -f "$dir/docker-compose.release.yml" down -v >/dev/null 2>&1 || true
  fi
  rm -rf "$dir"
}

for (( i = 0; i < ${#CONTAINER_NAMES[@]}; i++ )); do validatePull "${CONTAINER_NAMES[$i]}" "${CONTAINER_VERS[$i]}"; done
if [[ -n "$RUNTIME_IMAGE_VER" ]]; then validatePull "runtime" "$RUNTIME_IMAGE_VER"; fi
validateStack
exitForFindings
