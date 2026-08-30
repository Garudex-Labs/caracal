<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# AGENTS.md

Internal context for contributors and AI coding agents. Use `README.md` for the public API reference, `SETUP.md` for environment setup, and `docs/adding-a-harness.md` for harness integration.

## What Caracal is

Caracal is an agent-centric registry and observability platform for AI coding agents. Users interact with it three ways:

1. **CLI** (`caracal`): pull agents, sca harnesses, submit components, manage the server
2. **Web UI** (`apps/web/`): browse the registry, view traces, manage users, admin dashboard
3. **Caracal skill** (bundled, auto-installed on login): lets the LLM inside any harness drive Caracal commands directly (e.g. "create an agent that uses the github MCP")

Agents are the primary entity. Each agent bundles 5 component types: MCP servers, skills, hooks, prompts, and sandboxes. When a user runs `caracal agent pull <agent>`, the platform resolves all components and writes harness-specific config files.

## harness capability support

Ten harnesses are registered in `packages/harness-data/registry.json` (embedded by the Go `internal/harness` package). Support is per-capability, not a single tier. Verify against the registry before relying on this table.

| Harness | Hook spec | Session parser | Capabilities | Harness-specific e2e |
|---|---|---|---|---|
| Claude Code | yes | `claude-code` | hooks, mcp_servers, skills | no |
| Kiro | yes | `kiro` | hooks, mcp_servers | yes (9 specs) |
| Cursor | yes | `cursor` | hooks, mcp_servers | no |
| Pi | yes | `pi` | hooks, mcp_servers, skills | no |
| Codex CLI | yes | `codex` | hooks, mcp_servers, skills | no |
| Copilot | yes | `copilot-cli` (shared) | hooks, mcp_servers, skills, prompts | no |
| Copilot CLI | yes | `copilot-cli` | hooks, mcp_servers, skills, prompts | no |
| OpenCode | yes | `opencode` | hooks, mcp_servers, skills | no |
| Antigravity | yes | `antigravity` | hooks, mcp_servers, skills | no |
| Goose | yes | `goose` | hooks, mcp_servers, skills | no |

Every harness now resolves a session parser, so `caracal reconcile` works across all ten. Hook specs are defined in the Go doctor implementation (`cmd/caracal/doctorcmd.go`): `caracal doctor patch` installs managed hook groups for all ten harnesses whose commands invoke `caracal hook session-push`. Only Kiro has harness-specific Playwright coverage.

See `docs/adding-a-harness.md` for the complete guide to adding or promoting a harness.

## Architecture at a glance

```
apps/web/              Vite 6 SPA / React 19 / TanStack Router (see apps/web/AGENTS.md)
apps/auth/             Identity service (TypeScript, better-auth)

cmd/caracal/           Go CLI (cobra command groups: scancmd.go, doctorcmd.go, pullcmd.go, ...)
  assets/skills/       Bundled skills embedded in the binary, installed on login (caracal, caracal-admin, etc.)
cmd/caracal-server/    Go API server (route wiring, init container entry, health)
internal/              Go packages (harness registry, auth, ingest, sessions, telemetry, config, alerts, audit)
  cli/                 CLI internals (clierr, config, api, outbox, sessions, ref, lockfile, migrate, sandbox)

packages/harness-data/ Canonical harness registry + model catalogs (shared by all components)
packages/pi-extension/ Pi telemetry extension (npm: caracal-pi)

contracts/             Frozen wire contracts (openapi.v1.json, session-goldens/)
infra/                 Deployment assets (docker/ Compose stack + Dockerfiles, helm/, opentofu/, grafana/)
tools/                 Repository tooling (release prep, SBOM/license/VEX, model refresh, hook scripts)
docs/                  Documentation + repo media (docs/assets)

tests/                 Repo-level contract tests (release/version sync, helm OCI)
tests/integration/     Backend integration tests (real HTTP against a running stack)
tests/e2e/             Playwright (22 specs, requires running stack)
```

Unit tests are colocated with the code they cover: Go packages carry `*_test.go`
files (DB-backed invariants live in env-gated `*_live_test.go` files keyed on
`CARACAL_TEST_PG_URL`; CLI coverage lives under `internal/cli/`), and web unit
tests sit next to their module as `*.test.ts` (node --test).

## How the modularisation works

The codebase follows a strict adapter pattern for harness-specific logic. This is the most important architectural decision:

**One implementation per harness, on both sides.** CLI-side scanning and hook detection live in per-harness functions in `cmd/caracal/scancmd.go`; hook installation and cleanup in `cmd/caracal/doctorcmd.go` (shared checks in `doctorchecks.go`); session discovery in `internal/cli/sessions`. Server-side config generation lives in the Go `internal/harnessgen` adapters. The shared harness registry data (`packages/harness-data/registry.json`, loaded through `internal/harness`) defines paths, keys, capabilities, and event maps for both sides.

**Harness logic never leaks into shared code.** If you need harness-specific behavior, it goes in that harness's dedicated functions or adapter. The orchestrators (`caracal scan`, `caracal doctor`, and the `internal/harnessgen` engine) dispatch to exactly one per-harness implementation; shared engine code stays harness-agnostic.

**Capability gating.** The registry entry's `capabilities` set (`hooks`, `mcp_servers`, `skills`, `prompts`) decides what is allowed. Code checks `Spec.HasCapability` from `internal/harness` before performing a capability-specific operation, so a registry entry without a capability is safe: nothing attempts the unsupported operation.

**Transcript parsing is separate from adapters.** The row builder in `internal/ingest` converts raw JSONL into normalized trace events for every harness, with per-harness classification driven by the registry's `session_parser` key. Its behavior is pinned by the parity suite over `contracts/session-goldens`; Copilot reuses the Copilot CLI classification.

### What full support means concretely

A fully supported harness has all of:
- Doctor coverage in `cmd/caracal/doctorcmd.go` (diagnose, patch, and cleanup; defines what `doctor patch` installs)
- A session parser resolved from the registry's `session_parser` key (enables `caracal reconcile`)
- Full scanning implementation in `cmd/caracal/scancmd.go` (discovers MCPs, skills, hooks, agents)
- E2E test coverage in `tests/e2e/`

Today only Kiro meets all four. A minimal harness has:
- A registry entry with correct paths
- A scan implementation that handles basic MCP discovery
- An `internal/harnessgen` adapter that generates config files
- No doctor hook installation and no e2e tests

## Coding patterns we prefer

### Go (CLI and server)

- **Database migrations** are versioned SQL files embedded in the server binary under `internal/dbinit/migrations/{postgres,clickhouse}/`, applied by the init container (`caracal-server init`). The PostgreSQL schema version is tracked in `alembic_version`, ClickHouse versions in `clickhouse_schema_migrations`. Never add DDL to startup code. Scaffold new migrations with `make new-migration MSG="..."`.
- **Runtime settings live in the DB**, not env vars: read them through `internal/settings` (`settings.Store`); only boot-time wiring (URLs, secrets) comes from the environment.
- **Structured logs via `log/slog`**. Log IDs and counts, never secrets, tokens, keys, or JWT payloads.
- **Conventional Commits**: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`. Scope in parens. No fixup commits (amend instead).

### TypeScript (web)

Vite 6 SPA with TanStack Router, not Next.js. `apps/web/AGENTS.md` is the authoritative frontend reference; the rules below are the short form.

- **Auth storage is split.** `caracal_access_token` lives in sessionStorage; `caracal_refresh_token` and cached profile fields (role, name, email, username, avatar) live in localStorage so refresh survives reloads and new tabs. Do not widen localStorage use without changing the auth model deliberately.
- **TanStack Query hooks** from `use-api.ts` for all data fetching. Raw `fetch` in components is a known exception, not a pattern: a handful of call sites (co-authors, edit-lock release via `keepalive`, logout, SAML exchange) still use it. Do not add more.
- **Types centralized** in `src/lib/types.ts` (a barrel over `src/lib/types/`). No inline API response types.
- **harness list from server** (`/api/v1/config/harnesses`), never hardcoded in frontend.
- **OKLCH color tokens** in `src/app.css`. No raw hex/rgb in components.

### General

- **Skill files track CLI changes.** When any CLI command is added, removed, renamed, or has its flags changed, update the corresponding skill files in `cmd/caracal/assets/skills/`. They are embedded into the `caracal` binary and are the agent's source of truth for command syntax.
- **No telemetry wrappers or OTLP env vars.** MCP commands and remote URLs remain direct. Telemetry flows through session push hooks and reconciliation. Never generate `OTEL_*` or `CLAUDE_CODE_ENABLE_TELEMETRY` vars.
- **Owner fallback on install.** Submitters can install their own items without admin approval. Approved items are preferred, but pending/rejected items are accessible to the submitter.
- **Canonical registry identity is `namespace/slug`.** UUIDs remain accepted; legacy bare names resolve only when unambiguous. CLI slash-qualified references resolve to UUIDs before using existing action routes.
- **Hard rewrite policy.** No deprecation wrappers. When code moves, callers update in the same PR. Dead code is deleted immediately.
- **Tests mock externals.** No Docker needed to run the test suite. E2E specs in `tests/e2e/` are the exception (require running stack).

## CLI structure

```
caracal
├── api                      # authenticated JSON escape hatch for /api/v1 endpoints
├── use                      # show/select the org/project context ([ORG[/PROJECT]], --list)
├── sync                     # bring local installs up to date (--dry-run, --report, --harness)
├── pull                     # materialize an agent or component (--type to skip detection)
├── scan                     # read-only discovery of what's installed
├── reconcile                # backfill sessions missed by automatic delivery
├── auth                     # login, logout, whoami, status, change-password, set-username
├── config                   # show, set, path, alias, aliases
├── registry                 # component parent group
│   ├── mcp                  #   submit, list, show, install, edit, delete, co-authors
│   ├── skill                #   submit, list, show, install, edit, delete, co-authors
│   ├── hook                 #   submit, list, show, install, edit, delete, co-authors
│   ├── prompt               #   submit, list, show, edit, render, delete, co-authors
│   ├── sandbox              #   submit, list, show, edit, delete, co-authors
│   ├── models               #   inspect registry-backed harness model data
│   ├── version              #   component version commands
│   ├── recommend            #   components recommended from your own sessions
│   └── bulk                 #   mixed component submission from one JSON file
├── agent                    # list, show, versions, init, add, build, publish, release
│   └── pull                 #   install agent into harness (primary workflow)
├── ops                      # top, traces
│   ├── telemetry            #   status
│   ├── logs                 #   live dev log viewer
│   └── insights             #   agent insight reports
├── self                     # upgrade, downgrade, rollback, status
└── doctor                   # diagnose + patch harness settings for all 10 harnesses
    ├── patch / cleanup      #   install or remove telemetry hooks
    └── support              #   diagnostic bundle with redaction
```

`pull` exists both top-level (type detection across agents and components) and as `caracal agent pull`. Organization and project management, submission review, the inbox, and server administration live in the web UI; the embedded-server lifecycle belongs to the operator script (`infra/docker/server-package/ops.sh`). Run `caracal --help` to confirm before documenting a command path.

## Server routes

REST at `/api/v1/`. GraphQL at `/api/v1/graphql` (read-only telemetry layer with subscriptions).

Key route groups, all served by the Go `caracal-server` (`cmd/caracal-server`): `/api/v1/ingest/`, `/api/v1/sessions`, `/api/v1/telemetry`, `/api/v1/dashboard`, `/api/v1/config`, `/api/v1/alerts`, `/api/v1/audit`, `/api/v1/operator/*` (deployment control plane: overview, orgs, audit-log, logs, retention, users, settings, status, resources, AI engine, migrate, restart), `/api/v1/graphql`, `/api/v1/overview`, `/api/v1/exec` (including AI insight generation), `/api/v1/support`, `/api/v1/agents` (reads, writes, drafts, versions, install, harness config generation, and per-agent insight reports), `/api/v1/layer-snapshots`, `/api/v1/insights` (reads, deletions, generation, HTML export, and suggestion application - `internal/insights` + `internal/insightsgen`), the component family prefixes (`/api/v1/mcps`, `/api/v1/skills`, `/api/v1/hooks`, `/api/v1/prompts`, `/api/v1/sandboxes`), `/api/v1/registry`, `/api/v1/review`, `/api/v1/resources`, `/api/v1/recommendations`, `/api/v1/component-sources`, and `/api/v1/bulk`. Backing packages live under `internal/` (`ingest`, `sessions`, `traceview`, `telemetry`, `config`, `alerts`, `livewire`, `overview`, `execdash`, `logring`, `retention`, `support`, `agents`, `harnessgen`, `layers`, `insights`, `insightsgen`, `registry`, `adminops`, `operatorops`, `adminmigrate`, `llm`).

Deployment vs tenant authority: `/api/v1/operator/*` is the deployment control plane for the team hosting Caracal (platform statistics, tenant lifecycle metadata, service health, telemetry/AI engine config, deployment users). It is gated by `RequireRole("operator")` and is the ONLY place the `operator` deployment role grants authority. Organization administration (`/api/v1/orgs/{org}/*`, served by `internal/orgs`) is tenant-scoped: owner/admin/member roles in `organization_memberships`, resolved by membership JOIN keyed on `user_id` alone. The two never imply each other - an operator is a non-member (404) on org routes, and org owner/admin (deployment role `user`) can administer their org without any operator privilege. Operator does NOT hold implicit ownership of tenant content (agents, insight reports, alert secrets); those stay owner/co-author scoped. Boundary regression tests: `internal/orgs/boundary_test.go` and `internal/operatorops/handler_test.go`.

Tenancy: the Organization → Project model is served by the Go `internal/orgs` package; scoped routes resolve `{org_slug}`/`{project_slug}` and validate membership server-side (host subdomain / `X-Caracal-Org` must agree with the path). See `docs/architecture/org-project-model.md` for the model.

Project Intelligence is served by the Go `internal/orgs` package under `/api/v1/orgs/{org}/projects/{project}/intelligence`. Its canonical read contracts are `briefing` (state, evidence-backed signals, adoption, ownership, source freshness), `resources` (server-filtered/paginated operational rows), `resources/compare`, `resources/{resource}/versions`, and `history` (metric shifts, releases, and review issues). Keep cost authorization in `intelResolve`; unavailable sources return nullable metrics plus source status rather than fabricated zeroes.

## Database architecture

- **PostgreSQL**: relational data (users, agents, components, settings). Accessed through pgx pools.
- **ClickHouse**: session events, session aggregates, audit events, security events, and webhook deliveries. HTTP interface, MergeTree-family tables, bloom filter indexes. Schema changes use versioned SQL migrations in `internal/dbinit/migrations/clickhouse/`. The runtime client lives in `internal/clickhouse`.
- **Redis**: pub/sub for GraphQL subscriptions, dynamic settings cache, auth token revocation.

## Telemetry pipeline

```
harness ──→ session push hooks ──→ POST /api/v1/ingest/session ──→ ClickHouse
CLI ──→ caracal reconcile ──→ POST /api/v1/ingest/session ──→ ClickHouse
```

Session delivery uses a local outbox and resumes after transient network failures.

Telemetry is project-scoped: all producers send `X-Caracal-Org` and `X-Caracal-Project`; the server resolves membership and project ownership before ingest/checkpoint/session reads. Durable pending batches are bound to their original org/project and must never replay under a later selection. Live session/review channels are authenticated and project-namespaced.

## Auth model

- JWT bearer tokens. `Authorization: Bearer <token>` on every authenticated request. There is no `X-API-Key` path.
- JWT signing uses ES256 (not HS256). JWKS endpoint for public key distribution.
- Device authorization flow for CLI login via browser confirmation.
- Redis fail-closed: if Redis is down, auth fails (prevents stale token usage).
- Fresh servers auto-bootstrap admin on first `caracal auth login` (localhost-only).

## Commands

```bash
# Docker stack (10 services: init, api, db, clickhouse, redis, worker, web, lb, prometheus, grafana)
make up                  # start (OBS=prometheus|grafana adds monitoring)
make down                # stop
make rebuild             # rebuild and restart (S="caracal-server caracal-web" limits the build)
make logs                # tail logs (S="svc" filters)

# CLI (Go binary; version stamped at build time)
go build -o caracal -ldflags "-X main.cliVersion=<version>" ./cmd/caracal
caracal auth login      # auto-creates admin on fresh server, or login
caracal auth whoami     # check auth

# Linting
make lint                # gofmt + go vet
make format              # gofmt -w
make check               # pre-commit on all files
make setup               # install pre-commit hooks

# Tests (all mock externals, no Docker needed)
make test                # full suite: Go + web (SUITE=go|web limits to one)
make test SUITE=go       # go test -race ./... (includes tests/; CLI coverage lives in internal/cli/... and cmd/caracal)
make test SUITE=web      # web unit tests (node --test)
# Go live tests (inbox/lockfile/purge) run only when CARACAL_TEST_PG_URL is set.
# E2E (requires running stack):
cd tests/e2e && pnpm test   # 22 Playwright specs
```

## Dev logging

`caracal ops logs` streams `~/.caracal/logs/dev.log`.

- Server logs go through `log/slog`; the ring-buffer sink feeds SSE `/api/v1/operator/logs/stream` and the support bundle.
- Never log secrets, tokens, keys, JWT payloads. Log IDs and counts only.
- Log format (console/json) configured via the `observability.log_format` dynamic setting.

## AI contribution policy

See `AI_POLICY.md`. Key rules: no autonomous PRs without human authorship, every change must be explainable, label AI tool usage, frontend changes need screenshots, no slop.

## Paths to never commit

`.claude/`, `CLAUDE.md`, `.kiro/`, `.cursor/`, `.gemini/`, `GEMINI.md`, `.opencode/`, `.github/copilot-instructions.md`, `.copilot/`, `.vscode/`, `.worktrees/`
