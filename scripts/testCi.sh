#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Runs the same checks as .github/workflows/test.yml against the local checkout.

set -euo pipefail

cd "$(dirname "$0")/.."
root="$(pwd)"

run_ts=false
run_go=false
run_py=false
run_docs=false
run_smoke=false

if [[ $# -eq 0 ]]; then
  run_ts=true; run_go=true; run_py=true; run_docs=true
fi

for arg in "$@"; do
  case "$arg" in
    --all)   run_ts=true; run_go=true; run_py=true; run_docs=true ;;
    --smoke) run_smoke=true ;;
    --ts)    run_ts=true ;;
    --go)    run_go=true ;;
    --py)    run_py=true ;;
    --docs)  run_docs=true ;;
    -h|--help)
      cat <<EOF
Usage: scripts/testCi.sh [--all|--smoke|--ts|--go|--py|--docs]...
  no flags : run full suite (ts, go, py, docs)
  --smoke  : post-merge smoke (typecheck + go vet)
  --ts     : TypeScript lint, types, build, vitest with coverage
  --go     : go test -race with coverage
  --py     : python coverage run + unittest discover
  --docs   : pnpm --dir docs build
EOF
      exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

step() { echo; echo "==> $*"; }

if $run_smoke; then
  step "smoke: pnpm install"
  pnpm install --frozen-lockfile --prefer-offline
  step "smoke: pnpm -r build"
  pnpm -r build
  step "smoke: go vet"
  go vet \
    ./packages/core/go/... \
    ./services/sts/... \
    ./services/audit/... \
    ./services/gateway/... \
    ./apps/coordinator/relay/... \
    ./packages/transport/mcp/go/... \
    ./packages/connectors/nethttp/go/... \
    ./packages/identity/go/... \
    ./packages/revocation/go/... \
    ./packages/sdk/go/...
fi

if $run_ts || $run_docs; then
  step "pnpm install"
  pnpm install --frozen-lockfile --prefer-offline
fi

if $run_ts; then
  step "ts: sync embedded"
  pnpm --dir apps/cli sync-embedded

  step "ts: build packages"
  pnpm --dir packages/core/ts build
  pnpm --dir packages/oauth/ts build
  pnpm --dir packages/admin/ts build
  pnpm --dir packages/transport/a2a/ts build
  pnpm --dir packages/identity/ts build
  pnpm --dir packages/revocation/ts build
  pnpm --dir packages/transport/mcp/ts build
  pnpm --dir packages/connectors/express/ts build
  pnpm --dir packages/connectors/fastmcp/ts build
  pnpm --dir packages/connectors/postgres/ts build
  pnpm --dir apps/api build
  pnpm --dir apps/coordinator build

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
  ts_run apps/cli cli tests/typescript/unit/cli
  ts_run apps/tui tui tests/typescript/unit/tui
  ts_run packages/core/ts core tests/typescript/unit/shared
  ts_run packages/admin/ts admin tests/typescript/unit/admin
  ts_run packages/transport/a2a/ts transport-a2a tests/typescript/unit/transport-a2a
  ts_run packages/oauth/ts oauth tests/typescript/unit/sdk/oauth
  ts_run packages/connectors/express/ts mcp-express tests/typescript/unit/sdk/mcp-express
  ts_run packages/identity/ts identity tests/typescript/unit/identity
fi

if $run_go; then
  step "go: test with coverage"
  mkdir -p coverage/go
  go test -race -covermode=atomic -coverprofile=coverage/go/coverage.out \
    ./packages/core/go/... \
    ./services/sts/... \
    ./services/audit/... \
    ./services/gateway/... \
    ./apps/coordinator/relay/... \
    ./packages/transport/mcp/go/... \
    ./packages/connectors/nethttp/go/...
  go tool cover -func=coverage/go/coverage.out
fi

if $run_py; then
  step "py: install editable packages"
  python -m pip install \
    -e packages/core/python \
    -e packages/identity/python \
    -e packages/revocation/python \
    -e packages/transport/mcp/python \
    -e packages/connectors/fastmcp/python \
    coverage==7.13.5 cryptography==48.0.0

  step "py: coverage run"
  mkdir -p coverage/python
  PYTHONPATH="$root/packages/core/python:$root/packages/identity/python:$root/packages/revocation/python:$root/packages/transport/mcp/python:$root/packages/connectors/fastmcp/python:$root/tests/shared/test-utils/python" \
    coverage run --source=packages/core/python/caracalai_core,packages/identity/python/caracalai_identity,packages/revocation/python/caracalai_revocation,packages/transport/mcp/python/caracalai_transport_mcp,packages/connectors/fastmcp/python/caracalai_mcp_fastmcp \
    -m unittest discover -s tests/python -p 'test_*.py' -v
  coverage xml -o coverage/python/coverage.xml
  coverage report --show-missing
fi

if $run_docs; then
  step "docs: build"
  pnpm --dir docs build
  test -f docs/dist/index.html
  test -f docs/dist/CNAME
  grep -Fx 'docs.garudexlabs.com' docs/dist/CNAME
fi

echo
echo 'All requested CI checks passed.'
