#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Runs the same checks as .github/workflows/test.yml against the local checkout.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=scripts/lib/style.sh
. "scripts/lib/style.sh"

run_ts=false
run_go=false
run_py=false
run_docs=false
run_style=false
run_smoke=false
run_infra=false
run_deployment=false
run_workflows=false

if [[ $# -eq 0 ]]; then
  run_ts=true; run_go=true; run_py=true; run_docs=true; run_style=true; run_workflows=true
fi

for arg in "$@"; do
  case "$arg" in
    --all)   run_ts=true; run_go=true; run_py=true; run_docs=true; run_style=true; run_workflows=true ;;
    --smoke) run_smoke=true ;;
    --style) run_style=true ;;
    --ts)    run_ts=true ;;
    --go)    run_go=true ;;
    --py)    run_py=true ;;
    --docs)  run_docs=true ;;
    --infra) run_infra=true; run_workflows=true ;;
    --deployment) run_deployment=true; run_workflows=true ;;
    -h|--help)
      cat <<EOF
Usage: scripts/testCi.sh [--all|--smoke|--style|--ts|--go|--py|--docs|--infra|--deployment]...
  no flags : run full suite (style, ts, go, py, docs)
  --smoke  : full workspace/runtime build and go vet
  --style  : prettier, gofmt, and ruff format checks for changed files
  --ts     : TypeScript lint, types, build, vitest with coverage
  --go     : go test -race with coverage
  --py     : python coverage run + unittest discover
  --docs   : pnpm --dir docs build
  --infra  : Compose, Helm, OpenTofu, cloud manifests (requires their CLIs)
  --deployment : isolated source and runtime Compose E2E/failure/recovery
EOF
      exit 0 ;;
    *) say_error "Unknown flag: $arg"; exit 2 ;;
  esac
done

step() { say_step "$*"; }

step "toolchain: verify required versions"
node scripts/checkToolchain.mjs

if $run_smoke || $run_ts || $run_docs || $run_style || $run_infra || $run_deployment || $run_workflows; then
  step "pnpm install"
  pnpm install --frozen-lockfile --prefer-offline
fi

if $run_smoke; then
  if ! command -v bun >/dev/null 2>&1; then
    say_error "bun is required for pnpm -r build (apps/runtime)."
    say_label "Install: npm install --global bun@1.3.14"
    exit 1
  fi
  step "smoke: pnpm -r build"
  pnpm -r build
  step "smoke: go vet"
  node scripts/runGoTests.mjs --vet
fi



if $run_workflows; then
  step "workflows: validate invariants"
  node scripts/validateWorkflows.mjs
fi

if $run_style; then
  step "style: changed source"
  pnpm run style
fi

if $run_ts; then
  step "ts: sync embedded"
  pnpm --dir apps/runtime sync-embedded

  if ! $run_smoke; then
    step "ts: build packages"
    pnpm run build:typescript
  fi

  step "ts: lint"
  pnpm run lint
  step "ts: package export contracts"
  node tests/typescript/contract/sdk/package-consumer.mjs
  pnpm run knip
  step "ts: typecheck"
  pnpm -r --if-present typecheck

  step "ts: vitest with coverage"
  pnpm run test:coverage --coverage.reporter=lcov --coverage.reporter=text
fi

if $run_go; then
  step "go: vet"
  node scripts/runGoTests.mjs --vet
  step "go: race and coverage"
  node scripts/runGoTests.mjs --coverage
fi

if $run_py; then
  python_cmd="${PYTHON:-}"
  if [[ -z "$python_cmd" ]]; then
    if command -v python3 >/dev/null 2>&1; then python_cmd=python3; else python_cmd=python; fi
  fi
  py_venv="$(mktemp -d)"
  cleanup_py() {
    rm -rf "$py_venv"
  }
  trap cleanup_py EXIT

  step "py: create virtualenv"
  "$python_cmd" -m venv "$py_venv"
  py_python="$py_venv/bin/python"

  step "py: install locked test dependencies"
  "$py_python" -m pip install --require-hashes --requirement scripts/pythonTestRequirements.lock

  step "py: verify dependency constraints"
  "$py_python" -m pip check

  step "py: coverage run"
  PYTHON="$py_python" node scripts/runPythonTests.mjs --coverage -v
fi

if $run_docs; then
  step "docs: build"
  pnpm --dir docs build
  test -f docs/dist/index.html
  test -f docs/dist/CNAME
  grep -Fx 'docs.caracal.run' docs/dist/CNAME
fi

if $run_infra; then
  step "infra: validate configuration without live infrastructure"
  CARACAL_VERSION=1.0.0 docker compose -f infra/docker/runtime-compose.yml config --quiet
  docker compose -f infra/docker/docker-compose.yml config --quiet
  bash infra/helm/caracal/scripts/validate.sh
  bash infra/containerPlatform/scripts/validate.sh
  bash infra/tofu/scripts/validate.sh
fi

if $run_deployment; then
  step "deployment: build SDK and verify isolated source/runtime stacks"
  pnpm run build:typescript
  node infra/scripts/verifyDeployment.mjs --go-contracts --image-tag verify-local --report .caracal/deployment-source.json
  node infra/scripts/verifyDeployment.mjs --mode runtime --skip-build --image-tag verify-local --report .caracal/deployment-runtime.json
fi

echo
say_success "All requested CI checks passed."
