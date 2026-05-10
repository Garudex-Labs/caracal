# Contributing to Caracal

---

## Prerequisites

| Tool | Version | When required |
|---|---|---|
| Node.js | 24+ | Always |
| pnpm | 10+ | Always |
| Docker Engine + Compose v2 | 24+ | Always |
| Git | 2.x | Always |
| Go | 1.26+ | When changing Go services or shared Go packages |
| Python | 3.11+ | When changing the Python MCP package |
| Bun | latest stable | When building distributable CLI / TUI binaries |

---

## Repository Layout

```
apps/
  api/                 Admin / management plane (Fastify, TypeScript)
  cli/                 caracal CLI (TypeScript, Node 24 / Bun compile)
  tui/                 caracal-tui terminal UI (TypeScript, Node 24 / Bun compile)
  coordinator/         Coordinator with embedded Go relay
services/
  sts/                 Security Token Service (Go)
  gateway/             Policy enforcement gateway (Go)
  audit/               Audit log service (Go)
packages/
  core/                Caracal foundation (TypeScript, Go)
  identity/            JWT verification, JWKS, scope, claims (TypeScript, Go, Python)
  revocation/          Revocation lookup interface and in-memory default (TypeScript, Go, Python)
  oauth/               RFC 8693 token exchange client (TypeScript)
  transport-mcp/       MCP authentication core (TypeScript, Go, Python)
  transport-a2a/       Agent-to-agent transport primitives (TypeScript)
  sdk/                 Caracal identity/delegation SDK (TypeScript, Python, Go)
  admin/               Typed admin API client (TypeScript)
  framework-adaptor/   Per-framework adaptors over transport-mcp / sdk
  runtime-adaptor/     Per-runtime adaptors (e.g. Cloudflare)
  state-backend/       Storage backends (token state, token cache)
infra/
  docker/              Compose orchestration and .env template
  postgres/migrations/ SQL migrations applied by the API at boot
tests/
  typescript/          TypeScript test trees
  go/                  Go test trees
  python/              Python test trees
```

Each directory has an `instructions.md` that defines its structure and rules. Read it before making changes inside that directory.

---

## Setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/Garudex-Labs/caracal.git
cd caracal
pnpm install
```

### 2. Configure the local environment

```bash
cp infra/docker/.env.example infra/docker/.env
```

Edit `infra/docker/.env` and set real values for `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, and `CARACAL_ADMIN_TOKEN`.

### 3. Start the stack

```bash
pnpm caracal up
```

Builds and starts all services: `postgres`, `redis`, `sts`, `api`, `gateway`, `audit`, `coordinator`. The API applies database migrations on boot.

### 4. Provision the local zone

```bash
pnpm caracal init
```

Calls `POST /v1/local/bootstrap`, creates a zone, and writes `caracal.toml` in the repo root with a freshly generated client secret. Pass `--force` to re-provision and rotate the secret.

### Skip the `pnpm` prefix

Link the CLI globally once to use bare `caracal <cmd>` instead of `pnpm caracal <cmd>`:

```bash
pnpm link --global
# to unlink:
pnpm unlink --global caracal
```

---

## Stack Commands

```bash
pnpm caracal up              # Build images and start all services
pnpm caracal up --build      # Force rebuild even with cached layers
pnpm caracal down            # Stop all services
pnpm caracal down -v         # Stop and wipe all volumes (fresh state)
pnpm caracal status          # Probe /health on every service
pnpm caracal init            # Provision local zone and write caracal.toml
pnpm caracal init --force    # Re-provision and rotate the client secret
pnpm caracal --help          # Show all commands and options
```

Run a command with `RESOURCE_TOKEN` injected (useful for testing MCP flows):

```bash
pnpm caracal run -- printenv RESOURCE_TOKEN
pnpm caracal run -- node -e 'console.log(process.env.RESOURCE_TOKEN)'
```

Read a resolved credential:

```bash
pnpm caracal credential read <resource-name>
```

---

## Development

### Running the CLI from source

```bash
pnpm --dir apps/cli dev             # node bin/caracal.mjs
pnpm --dir apps/cli typecheck       # tsc --noEmit
```

### Running the TUI from source

The stack must be running and provisioned first.

```bash
export CARACAL_ADMIN_TOKEN=$(grep ^CARACAL_ADMIN_TOKEN infra/docker/.env | cut -d= -f2)

node apps/tui/bin/caracal-tui.mjs
# or:
pnpm --filter @caracalai/tui dev
```

### TUI environment variables

| Variable | Default | Notes |
|---|---|---|
| `CARACAL_ADMIN_TOKEN` | — | Required; TUI refuses to launch without it |
| `CARACAL_API_URL` | `http://localhost:3000` | All admin views |
| `CARACAL_COORDINATOR_URL` | `http://localhost:4000` | Agents view |
| `CARACAL_COORDINATOR_TOKEN` | — | Required for the agents view |
| `CARACAL_ZONE_ID` | — | Or set `zone_id` in `caracal.toml` |

Config file discovery order: `$CARACAL_CONFIG` → `caracal.toml` in cwd / `$PWD` / `$INIT_CWD` → `$XDG_CONFIG_HOME/caracal/caracal.toml`.

### TUI key bindings

| Key | Action |
|---|---|
| `j` / `k` or arrows | Move cursor |
| `Enter` | Drill into selected row |
| `h` / `←` / `Esc` | Go back one view |
| `g` / `G` | Jump to top / bottom |
| `r` | Reload current view |
| `p` | Pause / resume audit tail |
| `d` | Cycle audit decision filter (all → allow → deny → partial) |
| `q` / `Ctrl-C` | Quit |

---

## Tests

### Run the full suite

```bash
pnpm test
```

### Run a single layer

```bash
pnpm run test:typescript
pnpm run test:go
pnpm run test:python
```

### Run per-package

```bash
pnpm --dir apps/api test
pnpm --dir apps/cli test
pnpm --dir apps/tui test
go test ./services/sts/...
go test ./services/gateway/...
go test ./services/audit/...
```

---

## Code Style

- File headers and naming conventions are enforced by the rules in `.claude/rules/` and `.github/instructions/`.
- One current implementation per feature — no fallback paths, no compatibility shims, no commented-out code.
- Don't add abstractions, helpers, or features beyond what a change requires.
- Match the surrounding code's level of abstraction and naming style.

---

## Submitting Changes

1. Create a topic branch off `main`.
2. Make focused commits; keep unrelated cleanups in separate commits.
3. If your change touches the API, STS, or CLI, confirm end-to-end: `pnpm caracal up && pnpm caracal init && pnpm caracal run -- printenv RESOURCE_TOKEN`.
4. Run `pnpm test` and confirm it passes.
5. Open a pull request describing the change, affected directories, and any new `instructions.md` entries added.
6. Sign off with `git commit -s` if your change requires DCO.

---

## Building Binaries

Binaries are self-contained executables compiled with `bun build --compile`. They embed the runtime assets and require no Node.js or Bun on the target machine.

### CLI

```bash
# Sync embedded runtime assets first (required before any compile step)
pnpm --dir apps/cli sync-embedded

# Build all five targets at once
pnpm --dir apps/cli build

# Or build a single target
pnpm --dir apps/cli build:linux-x64
pnpm --dir apps/cli build:linux-arm64
pnpm --dir apps/cli build:darwin-x64
pnpm --dir apps/cli build:darwin-arm64
pnpm --dir apps/cli build:windows-x64
```

Output: `apps/cli/dist/caracal-<platform>[-<arch>][.exe]`

### TUI

```bash
# Build all five targets at once
pnpm --dir apps/tui build

# Or build a single target
pnpm --dir apps/tui build:linux-x64
pnpm --dir apps/tui build:linux-arm64
pnpm --dir apps/tui build:darwin-x64
pnpm --dir apps/tui build:darwin-arm64
pnpm --dir apps/tui build:windows-x64
```

Output: `apps/tui/dist/caracal-tui-<platform>[-<arch>][.exe]`

### Generate checksums

```bash
cd apps/cli/dist
sha256sum caracal-* > SHA256SUMS
cd ../../tui/dist
sha256sum caracal-tui-* >> ../../cli/dist/SHA256SUMS
```

---

## Releases

Releases are fully automated by [`.github/workflows/release.yml`](.github/workflows/release.yml).

### Cutting a release

1. Confirm `main` is green (all CI checks pass).
2. Tag with a semantic version and push:

```bash
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

### What the pipeline does

The `release` workflow triggers on `v*.*.*` tags and runs three jobs:

**`validate`** — runs `pnpm test` (TypeScript + Go + Python) against the tagged commit.

**`cli`** (parallel with `images`) —
1. Stamps `apps/cli/src/runtime/version.ts` and `apps/cli/package.json` with the tag version.
2. Runs `pnpm --dir apps/cli build` — builds five CLI binaries via `bun build --compile`:
   - `caracal-linux-x64`
   - `caracal-linux-arm64`
   - `caracal-darwin-x64`
   - `caracal-darwin-arm64`
   - `caracal-windows-x64.exe`
3. Runs `pnpm --dir apps/tui build` — builds five TUI binaries:
   - `caracal-tui-linux-x64`
   - `caracal-tui-linux-arm64`
   - `caracal-tui-darwin-x64`
   - `caracal-tui-darwin-arm64`
   - `caracal-tui-windows-x64.exe`
4. Generates `SHA256SUMS` covering all ten binaries.

**`images`** (parallel with `cli`) — builds and pushes five multi-arch (`linux/amd64`, `linux/arm64`) container images to GHCR with provenance and SBOM:

| Image | Dockerfile |
|---|---|
| `ghcr.io/garudex-labs/caracal-api` | `apps/api/Dockerfile` |
| `ghcr.io/garudex-labs/caracal-sts` | `services/sts/Dockerfile` |
| `ghcr.io/garudex-labs/caracal-gateway` | `services/gateway/Dockerfile` |
| `ghcr.io/garudex-labs/caracal-audit` | `services/audit/Dockerfile` |
| `ghcr.io/garudex-labs/caracal-coordinator` | `apps/coordinator/Dockerfile` |

Each image is tagged `vX.Y.Z`, `vX.Y`, and `latest`.

**`publish`** — creates a GitHub Release with auto-generated notes and attaches:
- All ten binaries (`caracal-*`, `caracal-tui-*`)
- `SHA256SUMS`
- `install.sh`
- `install.ps1`

### Versioning policy

| Bump | When |
|---|---|
| Major | Breaking CLI flags, API contracts, or Compose service interfaces |
| Minor | Additive features |
| Patch | Bug fixes |

### Preview embedded assets locally

To test runtime asset bundling without triggering a release:

```bash
pnpm --dir apps/cli sync-embedded
```

---

## Security

Do not file public issues for vulnerabilities. See [SECURITY.md](SECURITY.md) for the disclosure process.


## License

Caracal is Apache-2.0. By contributing you agree that your contribution is licensed under the same terms (see [LICENSE](LICENSE)).
