# Contributing to Caracal

## Prerequisites

| Tool | Version | Required for |
|---|---|---|
| Node.js | 24+ | All work |
| pnpm | 10+ | All work |
| Docker + Compose v2 | 24+ | Running the stack |
| Git | 2.x | All work |
| Go | 1.26+ | Go services / packages |
| Python | 3.11+ | Python packages |
| Bun | latest | Building CLI / TUI binaries |

## Repository Layout

```
apps/         api, cli, tui, coordinator
services/     sts, gateway, audit (Go)
packages/     core, identity, revocation, oauth, sdk, admin,
              transport/{mcp,a2a}, connectors/{express,fastmcp,postgres,nethttp}
infra/        docker compose, postgres migrations
tests/        typescript, go, python
scripts/      release automation
```

Every directory has an `instructions.md`. Read it before editing inside.

## Setup

```bash
git clone https://github.com/Garudex-Labs/caracal.git && cd caracal
pnpm install
cp infra/docker/.env.example infra/docker/.env   # set POSTGRES_PASSWORD, REDIS_PASSWORD, CARACAL_ADMIN_TOKEN
pnpm --filter './packages/**' build
pnpm caracal up                                  # start postgres, redis, sts, api, gateway, audit, coordinator
pnpm caracal init                                # provision local zone, write caracal.toml
```

To drop the `pnpm` prefix: `pnpm link --global` (and `pnpm unlink --global caracal` to undo).

## Stack Commands

```bash
pnpm caracal up [--build]           # start (optionally force rebuild)
pnpm caracal down [-v]              # stop (optionally wipe volumes)
pnpm caracal status                 # /health probe every service
pnpm caracal init [--force]         # provision zone (rotate secret with --force)
pnpm caracal run -- <cmd>           # run with RESOURCE_TOKEN injected
pnpm caracal credential read <res>  # resolve a credential
pnpm caracal --help
```

## Development

### CLI from source

```bash
pnpm --dir apps/cli dev
pnpm --dir apps/cli typecheck
```

### TUI from source

The stack must be up and provisioned first.

```bash
export CARACAL_ADMIN_TOKEN=$(grep ^CARACAL_ADMIN_TOKEN infra/docker/.env | cut -d= -f2)
pnpm --filter @caracalai/tui dev
```

### TUI environment

| Variable | Default | Notes |
|---|---|---|
| `CARACAL_ADMIN_TOKEN` | — | Required |
| `CARACAL_API_URL` | `http://localhost:3000` | Admin views |
| `CARACAL_COORDINATOR_URL` | `http://localhost:4000` | Agents view |
| `CARACAL_COORDINATOR_TOKEN` | — | Required for agents view |
| `CARACAL_ZONE_ID` | — | Or `zone_id` in `caracal.toml` |

Config discovery: `$CARACAL_CONFIG` → `caracal.toml` (cwd / `$PWD` / `$INIT_CWD`) → `$XDG_CONFIG_HOME/caracal/caracal.toml`.

### TUI keys

| Key | Action |
|---|---|
| `j` / `k` / arrows | Move |
| `Enter` | Drill in |
| `h` / `←` / `Esc` | Back |
| `g` / `G` | Top / bottom |
| `r` | Reload |
| `p` | Pause audit tail |
| `d` | Cycle audit filter |
| `q` / `Ctrl-C` | Quit |

## Tests

```bash
pnpm test                                  # full suite
pnpm run test:typescript | test:go | test:python
pnpm --dir apps/<name> test                # single package
go test ./services/<name>/...              # single Go service
```

### CI parity locally

`scripts/testCi.sh` runs the same checks as `.github/workflows/test.yml` against the local checkout.

```bash
scripts/testCi.sh             # full suite (ts + go + py + docs)
scripts/testCi.sh --smoke     # post-merge smoke: pnpm -r build + go vet
scripts/testCi.sh [--ts / --go / --py]        # any subset
gh workflow run release.yml -f dryRun=true
```

`--smoke` mirrors the post-merge job that runs on push to `main`; the full suite mirrors the daily scheduled and `workflow_dispatch` runs.

## Code Style

- Header and naming rules are enforced by `.claude/rules/` and `.github/instructions/`.
- One implementation per feature — no fallback paths, shims, or dead branches.
- Match surrounding abstraction level. Don't add helpers a single caller could inline.

## Submitting Changes

1. Branch off `main`. Keep commits focused.
2. Add a changeset for any change to a published package: `pnpm changeset`.
3. End-to-end check if you touched API / STS / CLI: `pnpm caracal up && pnpm caracal init && pnpm caracal run -- printenv RESOURCE_TOKEN`.
4. `pnpm test` must pass.
5. Open the PR; describe the change and any new `instructions.md` entries.
6. `git commit -s` for DCO sign-off.

## Building Binaries

`bun build --compile` produces self-contained executables (no Node / Bun runtime needed on the target).

```bash
pnpm --dir apps/cli sync-embedded                 # required before any compile
pnpm --dir apps/cli build                         # all 5 targets
pnpm --dir apps/cli build:<linux|darwin|windows>-<x64|arm64>
pnpm --dir apps/tui build                         # all 5 targets
```

Output: `apps/{cli,tui}/dist/caracal[-tui]-<os>-<bunArch>[.exe]` where `<bunArch>` is `x64` or `arm64`. The release workflow renames these into versioned archives (`caracal-{cli,tui}-<os>-{amd64,arm64}-<tag>.{tar.gz,zip}`); locally, work with the raw dist files.

## Releases

All release artifacts share one CalVer version: `vYYYY.MM.DD` (suffix `.N` for same-day re-cuts).

### Pipeline

Pushing a CalVer tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml):

| Job | Output |
|---|---|
| `cli` | 10 archives (5 CLI + 5 TUI), `SHA256SUMS`, SLSA provenance |
| `images` | 5 multi-arch images on GHCR with provenance + SBOM, tagged `vYYYY.MM.DD[.N]`, `vYYYY.MM`, `latest` |
| `publish` | GitHub Release with archives, `SHA256SUMS`, `install.sh`, `install.ps1` |

### Release archives

Each archive contains exactly one binary (`caracal` or `caracal-tui`, `.exe` on Windows):

| Asset | Format |
|---|---|
| `caracal-cli-linux-amd64-vYYYY.MM.DD.tar.gz` | tar.gz |
| `caracal-cli-linux-arm64-vYYYY.MM.DD.tar.gz` | tar.gz |
| `caracal-cli-darwin-amd64-vYYYY.MM.DD.tar.gz` | tar.gz |
| `caracal-cli-darwin-arm64-vYYYY.MM.DD.tar.gz` | tar.gz |
| `caracal-cli-windows-amd64-vYYYY.MM.DD.zip` | zip |
| `caracal-tui-...` | same five targets, optional install |

### Cutting a release

```bash
git tag v2026.05.12 && git push origin v2026.05.12
```

Only maintainers listed in `.github/MAINTAINERS` may push release tags.

### Validating a release

After `release.yml` completes successfully for a release tag, the `Post-Release Validation` workflow runs automatically (or trigger manually with `gh workflow run postReleaseValidation.yml -f release=v2026.05.12`). It exercises registries, archives, installers, containers, and provenance against `releases/<tag>/manifest.json`, then opens a PR adding `releases/<tag>/validation.md` and `releases/<tag>/findings/*.jsonl`.

Reproduce a single area locally:

```bash
CARACAL_RELEASE=v2026.05.12 FINDINGS_DIR=/tmp/findings \
  bash scripts/postRelease/validateRegistryMetadata.sh   # or any validate*.sh
```

### npm and PyPI

Packages are published locally with manually-entered tokens:

```bash
./scripts/publishNpm.sh
./scripts/publishPypi.sh            # PyPI
./scripts/publishPypi.sh --testpypi  # TestPyPI
```

Each script presents an interactive picker (up/down, space to toggle, `a` toggles all, enter confirms), prompts for the registry token, builds, and uploads each selected package, skipping versions already on the registry.

Browse published versions:

- npm: <https://www.npmjs.com/~caracal-run>
- PyPI: <https://pypi.org/user/CaracalAI>

### Published artifacts

```
npm:    @caracalai/{core,oauth,admin,identity,revocation,sdk,
                    transport-mcp,transport-a2a,
                    mcp-express,mcp-fastmcp,tokenstate-postgres,revocation-redis}
pypi:   caracalai-{core,identity,revocation,sdk,transport-mcp,mcp-fastmcp,revocation-redis}
ghcr:   ghcr.io/garudex-labs/caracal-{api,sts,gateway,audit,coordinator}
```

### Rollback

Never delete a published tag. Roll forward by cutting a new CalVer tag. Floating image tags (`latest`, `vYYYY.MM`) move with the new cut.

## Security

Do not file public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

Apache-2.0. By contributing you agree your contribution is licensed under the same terms ([LICENSE](LICENSE)).
