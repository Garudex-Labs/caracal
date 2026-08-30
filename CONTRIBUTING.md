<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing to Caracal

This guide answers one question: how do I make a change to this repository and get it merged? For architecture context see [AGENTS.md](AGENTS.md); for environment details see [SETUP.md](SETUP.md) and the [Development Guide](docs/DEVELOPMENT_GUIDE.md).

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Go | 1.25+ (see `go.mod`) | services, CLI, tooling, most tests |
| Node.js | 24 | web UI, auth service, pi-extension |
| pnpm | 10 | JS workspace (`apps/web`, `apps/auth`, `tests/e2e`) |
| Docker Engine + Compose v2 | ≥ 24.0, `docker compose` | local stack, integration and e2e tests |
| Git | any recent | everything |
| [uv](https://docs.astral.sh/uv/) | any recent | pre-commit hook runner only (`uvx`) |

Verify:

```bash
go version && node --version && pnpm --version && docker compose version
```

## Repository setup

Fork [Garudex-Labs/caracal](https://github.com/Garudex-Labs/caracal) on GitHub, then:

```bash
git clone https://github.com/YOUR-USERNAME/caracal.git
cd caracal
git remote add upstream https://github.com/Garudex-Labs/caracal.git
git remote -v                      # origin = your fork, upstream = Garudex-Labs

make setup                         # install pre-commit hooks (do this once)
pnpm install --frozen-lockfile     # JS workspace dependencies
cp .env.example .env               # working local defaults, no edits needed
```

Contributor commands live in `Makefile.dev` and are listed by `make help-dev`; `make help` shows the operator commands for running the stack.

## Git workflow

```text
fork -> clone -> add upstream -> branch -> change -> check -> commit -> push -> PR
```

```bash
# start from fresh upstream state
git fetch upstream
git switch -c feature/new-feature upstream/main    # or fix/..., docs/...

# while working
git status
git diff
git add <files>
git commit                        # conventional commit, see below

# keep the branch current
git fetch upstream
git rebase upstream/main

# publish
git push -u origin feature/new-feature             # then open a PR on GitHub
git push --force-with-lease                            # after a rebase
```

Branch names: `feature/<topic>`, `fix/<topic>`, `docs/<topic>`.

### Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, with an optional scope. Subject under 72 characters, imperative mood, no trailing period. Amend instead of stacking fixup commits.

```text
feat(cli): add skill submit command
fix(telemetry): handle null span timestamps
```

Add an entry under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for any user-facing change.

## Complete local stack

The stack is ten Compose services: init (migrations), Go API server, auth service, web UI, PostgreSQL, ClickHouse, Redis, and an nginx load balancer on `http://localhost`.

```bash
make rebuild             # build images and start everything
make up                  # build local images, start everything, wait for API/web health
make logs                # tail all service logs (S="caracal-server" to filter)
make down                # stop
make reset               # wipe volumes and rebuild from scratch (asks for confirmation)
```

While iterating on app code, `make rebuild S="caracal-server caracal-web"` rebuilds only those images and skips the rest.

Then build the CLI and log in:

```bash
go build -o ~/.local/bin/caracal ./cmd/caracal
caracal auth login       # first login on a fresh server bootstraps the admin account
caracal auth whoami
```

Health check: `curl http://localhost/health`.

## Frontend mock development

To work on the web UI without any backend:

```bash
cd apps/web
pnpm dev:mock            # http://localhost:8000, any credentials log in
```

The mock serves every `/api/v1/*` route from fixtures in [apps/web/mock/](apps/web/mock/) with realistic shapes and stateful mutations. It does not enforce real authorization, does not mock the `/api/auth/*` identity service (those pages show error states), and proves nothing about server behavior. Hitting an unmocked endpoint logs a 404 with the path in the Vite terminal; add the route in `mock/handlers.ts`.

`pnpm dev` (without the mock) proxies `/api` to `http://localhost:8080` per `vite.config.ts`; for full-stack work prefer the Docker stack, which serves the built UI at `http://localhost`.

## Testing

Fast checks while iterating:

```bash
go test ./internal/<package>/          # focused Go tests
cd apps/web && pnpm typecheck          # TS typecheck
cd apps/web && pnpm test               # web unit tests (node --test)
```

Before opening a PR (this is what CI runs):

```bash
make lint                # gofmt + go vet
go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest run ./...
make test SUITE=go       # go test -race ./... (includes the contract tests in tests/)
cd apps/web && pnpm lint && pnpm typecheck && pnpm test
cd apps/auth && pnpm typecheck
make check               # pre-commit hooks on all files (SPDX, secrets, YAML, hadolint)
```

Unit and contract tests mock all externals; no Docker needed. Two suites are opt-in:

```bash
# integration tests: real HTTP against a running stack (make up first)
go test ./tests/integration/

# e2e: Playwright against a running stack
pnpm e2e
```

Some Go DB-invariant tests run only when `CARACAL_TEST_PG_URL` points at a migrated Postgres (the local stack works: `postgresql://postgres:postgres@127.0.0.1:5432/caracal`).

### Where tests live

| Kind | Location |
|---|---|
| Go unit tests | `*_test.go` next to the code (`internal/...`, `cmd/...`) |
| Go DB-backed live tests | `*_live_test.go`, gated on `CARACAL_TEST_PG_URL` |
| Web unit tests | `apps/web/src/**/*.test.ts` |
| Repo contract tests | `tests/*.go` (release/version sync, OpenAPI, helm OCI) |
| Integration tests | `tests/integration/` |
| E2E (Playwright) | `tests/e2e/*.spec.ts` |

Keep tests hermetic and assert behavior, not implementation. See the [Testing Guide](docs/testing/Testing_Guide.md).

## Backend development

The API server is `cmd/caracal-server`; domain packages live under `internal/`. Typical loop:

```bash
go build ./...                                   # compile everything
go test ./internal/<package>/ -run TestName -v   # focused test
make rebuild S="caracal-server caracal-web"      # redeploy into the stack
docker logs docker-caracal-server-1 --since 5m   # server logs
caracal ops logs                                 # live dev log viewer
```

Validate API changes against the running stack with `curl` against `http://localhost/api/v1/...` (bearer token from `caracal auth login`). Error responses follow a fixed envelope (`detail`, `code`, `retryable`, `request_id`); keep it intact. If you change a wire shape, check `contracts/openapi.v1.json` and the frontend types in `apps/web/src/lib/types/`.

## Frontend development

```bash
cd apps/web
pnpm dev:mock            # UI-only work
pnpm lint                # eslint
pnpm typecheck           # tsc --noEmit
pnpm test                # unit tests
pnpm build               # production build (tsc + vite)
```

Conventions live in [apps/web/AGENTS.md](apps/web/AGENTS.md): data fetching through the TanStack Query hooks in `use-api.ts`, types centralized in `src/lib/types.ts`, OKLCH color tokens (no raw hex in components), harness list fetched from the server. PRs that change the UI must include screenshots of affected screens.

## Database and ClickHouse

Schema changes are versioned SQL migrations in `internal/dbinit/migrations/{postgres,clickhouse}/`, applied by the init container. Never add DDL to service startup code, and never edit an already-committed migration; add a new one.

```bash
make new-migration MSG="add foo to bar"    # scaffold the next numbered file
make migrate                               # apply migrations to the running stack
make reset                                 # fresh databases from scratch (asks for confirmation)

# inspect
docker exec -it docker-caracal-db-1 psql -U postgres caracal
curl -s 'http://localhost:8123/' --data 'SELECT 1' -u default:clickhouse
```

Pin schema-dependent behavior with a live test (`*_live_test.go` + `CARACAL_TEST_PG_URL`) where it matters.

## CLI development

The CLI is `cmd/caracal` (cobra command groups per file: `scancmd.go`, `doctorcmd.go`, ...):

```bash
go build -o ~/.local/bin/caracal ./cmd/caracal
go test ./cmd/caracal/ ./internal/cli/...
```

When you add, remove, or change a command or its flags, update the bundled skill files under `cmd/caracal/assets/skills/` (embedded in the binary) and the CLI reference in `docs/cli/`. Full walkthrough: [Adding a CLI command](docs/adding-a-cli-command.md). For harness support work, see [Adding a harness](docs/adding-a-harness.md).

## Infrastructure and tooling

```bash
# Compose changes
cd infra/docker && docker compose config -q

# Helm chart
helm lint infra/helm/caracal

# OpenTofu modules
tofu fmt -check -recursive infra/opentofu/

# GitHub workflows
go run github.com/rhysd/actionlint/cmd/actionlint@latest -no-color .github/workflows/*.yml
```

Dockerfiles are checked by hadolint through `make check`.

## Release changes

Releases are curated PRs prepared by the release tool; versions originate in `.release.toml` and must stay in sync across the version files (enforced by `tests/version_sync_test.go` and CI's governance job).

```bash
make release PREVIEW=1   # dry run, writes nothing
make release             # interactively prepare a release PR
```

Contributors normally never run a release; if your change touches versioning, release configuration, or `.github/workflows/release.yml`, run `make test` and `make release PREVIEW=1` and describe the impact in the PR.

## Pull requests

A good PR has:

- One focused change with a conventional-commit title.
- Tests for the behavior it adds or fixes.
- A description that says what changed and why; note behavioral, migration, or security implications.
- Screenshots for any visible web UI change.
- A `[Unreleased]` changelog entry for user-facing changes.
- Green CI (the same checks as the [Testing](#testing) section).

The CLA-assistant bot asks you to sign the [Caracal CLA](CLA.md) on your first PR; you sign once. Review standards are described in [docs/code-review.md](docs/code-review.md).

## Security, licensing, and AI assistance

- Never commit secrets: no credentials, tokens, private keys, or `.env` files. `make check` runs secret scanning (`tools/check_secrets.sh`, `detect-private-key`); CI runs gitleaks.
- Report vulnerabilities privately per [SECURITY.md](SECURITY.md), never in issues or PRs.
- All contributions are licensed under [Apache-2.0](LICENSE.md); attribution lives in [NOTICE](NOTICE), and the [CLA](CLA.md) applies.
- AI-assisted contributions are welcome under [AI_POLICY.md](AI_POLICY.md): label the tool used, and you remain fully responsible for reviewing, testing, and explaining every line you submit.
- Every source file carries SPDX headers; the pre-commit hook adds them automatically.

## Generated and managed files

Do not hand-edit:

- `apps/web/src/routeTree.gen.ts` - regenerated by the TanStack Router plugin while `pnpm dev` runs.
- `pnpm-lock.yaml`, `go.sum` - updated by their package managers.
- `contracts/openapi.v1.json` and `contracts/session-goldens/` - frozen wire contracts; changing them is a deliberate, reviewed act, not a side effect.
- Committed migration files - immutable once merged; add a new migration instead.

## Troubleshooting

```bash
docker compose -f infra/docker/docker-compose.yml ps    # service status
docker logs docker-caracal-server-1 --since 10m          # one service's logs
make logs                                                # everything
curl http://localhost/health                             # stack health
make migrate                                             # re-run migrations
make reset                                               # nuke volumes, start fresh (asks for confirmation)
make clean                                               # remove build caches
git remote -v && git fetch upstream                      # remote sanity
go clean -testcache                                      # stale Go test results
```

If a rebase leaves conflicts: resolve the files, `git add` them, `git rebase --continue`, then `git push --force-with-lease`. When in doubt, ask in the PR or open a discussion.
