# cli

## Scope
- Covers only the `caracal` CLI under `caracal/apps/cli/`.

## Required
- Must run on Node 24+ via `bin/caracal.mjs`; release artifacts are produced via `bun build --compile` for linux/darwin/windows × x64/arm64.
- Must support the stack commands: `caracal up [services...]`, `caracal down [flags...]`, `caracal status`, `caracal init` (provisions the local zone via `POST /v1/local/bootstrap` and writes `caracal.toml`).
- Must support the runtime commands: `caracal run <cmd...>` (ambient 60-min token injection) and `caracal credential read <resource>` (one-shot 15-min token).
- Must support the admin commands wrapping the `/v1/*` API via `@caracalai/admin`: `zone`, `app`, `resource`, `provider`, `policy`, `policy-set`, `grant`, `session`.
- Must support the observability commands: `audit tail` (with `--since`, `--until`, `--decision`, `--request-id`, `--event-type`, `--limit`) and `explain <request_id>` (audit row plus determining policies plus diagnostics).
- Must support the multi-agent commands wrapping the agent coordinator API: `agent <list|get|tree|suspend|resume|terminate>` and `delegation <inbound|outbound|traverse|revoke>`.
- Must require `CARACAL_ADMIN_TOKEN` for all admin and observability commands; must require `CARACAL_COORDINATOR_TOKEN` (JWT with `agent:lifecycle` scope) for agent and delegation commands; must surface a clear error when missing.
- Must select stack mode in this order: (1) explicit `$CARACAL_STACK_MODE=runtime` → runtime mode; (2) walk up from `$CARACAL_REPO_ROOT`, `$INIT_CWD`, `$PWD`, cwd, and the CLI module path for `infra/docker/docker-compose.yml` → dev mode; (3) fall back to runtime mode at the default home.
- Must, in runtime mode, auto-provision `compose.yml`, `provision-streams.sh` (mode 0755), and `.env` (mode 0600) into `$CARACAL_HOME` (default: macOS `~/Library/Application Support/caracal`, otherwise `$XDG_DATA_HOME/caracal` or `~/.local/share/caracal`) using assets bundled at build time, seeding `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, and `CARACAL_ADMIN_TOKEN` with cryptographically random values.
- Must, in runtime mode, pin container image tags to the CLI's `CARACAL_VERSION` constant (overridable by `CARACAL_VERSION` env) and pull from `ghcr.io/garudex-labs/caracal-{api,sts,gateway,audit,coordinator}`.
- Must regenerate `src/runtime/embedded.ts` via `scripts/build-embedded.mjs` before every binary build; the file is generated and gitignored.
- Must resolve `caracal.toml` in this order: `$CARACAL_CONFIG`, `./caracal.toml` (cwd / `$PWD` / `$INIT_CWD`), then `$XDG_CONFIG_HOME/caracal/caracal.toml` (defaulting to `~/.config/caracal/caracal.toml`).
- Must persist `zone_id` into `caracal.toml` during `init` so admin commands resolve the default zone without flags.
- Must accept `--zone <id>` on every admin command and fall back to `zone_id` from `caracal.toml` or `CARACAL_ZONE_ID`.
- Must support `--json` on every read command to emit raw JSON instead of a table.
- Must read zone config from `caracal.toml`; must never write credentials to disk except the secret returned by `caracal init`, written with mode 0600 to the resolved config path.
- Must reap injected env vars when the child process exits.
- Must support `continue_on_failure` opt-in and optional resources with `on_failure = "warn"`.
- Must implement MCP shadow governance: exit 1 on unauthorized MCP servers unless `mcp_governance = "log"`.
- Must talk to the admin API and coordinator only through `@caracalai/admin`; must not issue raw `fetch` calls to admin endpoints from CLI command modules.

## Forbidden
- Must not import from `caracalEnterprise/`.
- Must not write credentials, tokens, or refresh tokens to disk outside the `caracal init` flow.
- Must not depend on a Bun runtime at execution time; child-process spawning must use `node:child_process`.
- Must not duplicate admin route paths or schemas inside the CLI; the `@caracalai/admin` SDK is the single source.
