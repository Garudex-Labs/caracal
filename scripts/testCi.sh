#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Runs the same checks as .github/workflows/test.yml against the local checkout.

set -euo pipefail

cd "$(dirname "$0")/.."
root="$(pwd)"

# shellcheck source=lib/style.sh
. "scripts/lib/style.sh"

go_cmd="$(go env GOROOT)/bin/go"
if [[ ! -x "$go_cmd" ]]; then
  go_cmd=go
fi
go_pkgs=(
  ./packages/core/go/...
  ./services/sts/...
  ./services/audit/...
  ./services/gateway/...
  ./services/coordinator-relay/...
  ./packages/transport/mcp/go/...
  ./packages/connectors/nethttp/go/...
  ./packages/connectors/redis/go/...
  ./packages/identity/go/...
  ./packages/oauth/go/...
  ./packages/revocation/go/...
  ./packages/sdk/go/...
)

run_ts=false
run_go=false
run_py=false
run_docs=false
run_style=false
run_smoke=false

if [[ $# -eq 0 ]]; then
  run_ts=true; run_go=true; run_py=true; run_docs=true; run_style=true
fi

for arg in "$@"; do
  case "$arg" in
    --all)   run_ts=true; run_go=true; run_py=true; run_docs=true; run_style=true ;;
    --smoke) run_smoke=true ;;
    --style) run_style=true ;;
    --ts)    run_ts=true ;;
    --go)    run_go=true ;;
    --py)    run_py=true ;;
    --docs)  run_docs=true ;;
    -h|--help)
      cat <<EOF
Usage: scripts/testCi.sh [--all|--smoke|--style|--ts|--go|--py|--docs]...
  no flags : run full suite (style, ts, go, py, docs)
  --smoke  : post-merge smoke (typecheck + go vet)
  --style  : prettier, gofmt, and ruff format checks for changed files
  --ts     : TypeScript lint, types, build, vitest with coverage
  --go     : go test -race with coverage
  --py     : python coverage run + unittest discover
  --docs   : pnpm --dir docs build
EOF
      exit 0 ;;
    *) say_error "Unknown flag: $arg"; exit 2 ;;
  esac
done

step() { say_step "$*"; }

if $run_smoke; then
  step "smoke: pnpm install"
  pnpm install --frozen-lockfile --prefer-offline
  if ! command -v bun >/dev/null 2>&1; then
    say_error "bun is required for pnpm -r build (apps/runtime, apps/console)."
    say_label "Install: npm install --global bun@1.3.14"
    exit 1
  fi
  step "smoke: pnpm -r build"
  pnpm -r build
  step "smoke: go vet"
  "$go_cmd" vet "${go_pkgs[@]}"
fi

if $run_ts || $run_docs || $run_style; then
  step "pnpm install"
  pnpm install --frozen-lockfile --prefer-offline
fi

if $run_style; then
  step "style: changed source"
  pnpm run style
fi

if $run_ts; then
  step "ts: sync embedded"
  pnpm --dir apps/runtime sync-embedded

  step "ts: build packages"
  pnpm run build:typescript

  step "ts: lint"
  pnpm -r --if-present lint
  step "ts: typecheck"
  pnpm -r --if-present typecheck

  step "ts: vitest with coverage"
  ts_run() {
    local dir="$1" out="$2"; shift 2
    pnpm --dir "$dir" exec vitest run --root "$root" \
      --coverage.enabled true \
      --coverage.provider=v8 \
      --coverage.reporter=lcov \
      --coverage.reportsDirectory="$root/coverage/typescript/$out" \
      "$@"
  }
  ts_run apps/api api \
    tests/typescript/unit/api \
    tests/typescript/security/api \
    tests/typescript/property/api \
    tests/typescript/contract/api \
    tests/typescript/fuzz/api \
    tests/typescript/integration/api
  ts_run apps/coordinator coordinator tests/typescript/unit/orchestration/coordinator
  ts_run apps/runtime runtime tests/typescript/unit/runtime
  ts_run apps/console Console tests/typescript/unit/console
  ts_run packages/core/ts core tests/typescript/unit/shared
  ts_run packages/admin/ts admin tests/typescript/unit/admin
  ts_run packages/sdk/ts sdk tests/typescript/unit/sdk/client.test.ts
  ts_run packages/transport/a2a/ts transport-a2a tests/typescript/unit/transport-a2a
  ts_run packages/oauth/ts oauth tests/typescript/unit/sdk/oauth
  ts_run packages/revocation/ts revocation tests/typescript/unit/revocation
  ts_run packages/transport/mcp/ts transport-mcp tests/typescript/unit/transport-mcp
  ts_run packages/connectors/express/ts mcp-express tests/typescript/unit/sdk/mcp-express
  ts_run packages/connectors/fastmcp/ts mcp-fastmcp tests/typescript/unit/sdk/mcp-fastmcp
  ts_run packages/connectors/postgres/ts tokenstate-postgres tests/typescript/unit/connectors/postgres
  ts_run packages/connectors/redis/ts tokenstate-redis tests/typescript/unit/connectors/redis
  ts_run packages/identity/ts identity tests/typescript/unit/identity
  ts_run apps/control control tests/typescript/unit/control tests/typescript/integration/control
fi

if $run_go; then
  step "go: race"
  mkdir -p coverage/go
  bash scripts/runGoSourceTests.sh "$go_cmd" test -race "${go_pkgs[@]}"

  step "go: coverage"
  bash scripts/runGoSourceTests.sh "$go_cmd" test -covermode=atomic -coverprofile=coverage/go/coverage.out "${go_pkgs[@]}"
  "$go_cmd" test -race -covermode=atomic \
    -coverpkg=github.com/garudex-labs/caracal/packages/transport/mcp/go,github.com/garudex-labs/caracal/packages/revocation/go,github.com/garudex-labs/caracal/packages/identity/go \
    -coverprofile=coverage/go/tests.out \
    ./tests/go/unit/revocation \
    ./tests/go/unit/transport/mcp \
    ./tests/go/unit/identity \
    ./tests/go/contract/interoperability
  tail -n +2 coverage/go/tests.out >> coverage/go/coverage.out
  "$go_cmd" tool cover -func=coverage/go/coverage.out
fi

if $run_py; then
  py_venv="$(mktemp -d)"
  cleanup_py() {
    rm -rf "$py_venv"
  }
  trap cleanup_py EXIT

  step "py: create virtualenv"
  python -m venv "$py_venv"
  py_python="$py_venv/bin/python"
  py_coverage="$py_venv/bin/coverage"

  step "py: install editable packages"
  "$py_python" -m pip install \
    -e packages/core/python \
    -e packages/oauth/python \
    -e packages/identity/python \
    -e packages/revocation/python \
    -e packages/sdk/python \
    -e packages/transport/mcp/python \
    -e packages/connectors/fastmcp/python \
    -e packages/connectors/redis/python \
    coverage==7.14.0 cryptography==48.0.0

  step "py: coverage run"
  mkdir -p coverage/python
  PYTHONPATH="$root/packages/core/python:$root/packages/oauth/python:$root/packages/identity/python:$root/packages/revocation/python:$root/packages/sdk/python:$root/packages/transport/mcp/python:$root/packages/connectors/fastmcp/python:$root/packages/connectors/redis/python:$root/tests/shared/test-utils/python" \
    "$py_coverage" run --source=packages/core/python/caracalai_core,packages/oauth/python/caracalai_oauth,packages/identity/python/caracalai_identity,packages/revocation/python/caracalai_revocation,packages/sdk/python/caracalai,packages/transport/mcp/python/caracalai_transport_mcp,packages/connectors/fastmcp/python/caracalai_mcp_fastmcp,packages/connectors/redis/python/caracalai_revocation_redis \
    -m unittest discover -s tests/python -p 'test_*.py' -v
  "$py_coverage" xml -o coverage/python/coverage.xml
  "$py_coverage" report --show-missing
fi

if $run_docs; then
  step "docs: build"
  pnpm --dir docs build
  test -f docs/dist/index.html
  test -f docs/dist/CNAME
  grep -Fx 'docs.caracal.run' docs/dist/CNAME
fi

echo
say_success "All requested CI checks passed."
