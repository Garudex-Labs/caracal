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
scripts/testCi.sh --ts        # any subset
scripts/testCi.sh --go --py
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

Output: `apps/{cli,tui}/dist/caracal[-tui]-<platform>[-<arch>][.exe]`. Generate `SHA256SUMS` with `sha256sum caracal-* > SHA256SUMS` in each `dist/`.

## Releases

Automated by [`.github/workflows/release.yml`](.github/workflows/release.yml), gated by [Changesets](https://github.com/changesets/changesets).

### Versioning

| Layer | Format | Owner |
|---|---|---|
| Repo tag, GitHub Release, container images, CLI binaries | CalVer `vYYYY.MM.DD` (suffix `.N` for same-day re-cuts) | release tag |
| npm `@caracalai/*` | per-package semver | Changesets |
| PyPI `caracalai-*` | per-package semver | hand-edited `pyproject.toml` |
| Go modules | per-module semver tags | hand-applied when needed |

The CalVer tag triggers the workflow but does not dictate package versions.

### Per-package semver

| Bump | When |
|---|---|
| Major | Breaking SDK / API contract, removed export, removed CLI flag |
| Minor | Additive feature, new export, new CLI subcommand |
| Patch | Bug fix, dependency bump, internal refactor |

### Authoring a changeset

```bash
pnpm changeset
```

Pick affected packages and bump type. Commit the generated `.changeset/*.md` with the PR. Internal packages (`cli`, `tui`, `api`, `coordinator`) are ignored.

### Cutting a release

```bash
./scripts/release.sh             # full release
./scripts/release.sh --dry-run   # preview tag and version bumps; reverts cleanly
```

The script: verifies clean `main`, computes the next CalVer tag, runs `pnpm changeset version` (bumps versions, rewrites `workspace:*`), commits, tags, pushes.

### Pre-publish dry run via CI

```bash
gh workflow run release.yml --field dryRun=true --field ref=main
```

Builds all artifacts, packs npm tarballs into `npm-tarballs`, builds (does not push) images, builds (does not publish) wheels, skips the GitHub Release.

### Pipeline

Triggers on `vYYYY.MM.DD[.N]`. After `validate` (full test suite):

| Job | Output |
|---|---|
| `cli` | 5 CLI + 5 TUI binaries, `SHA256SUMS`, SLSA provenance |
| `npm` | 11 packages via `pnpm changeset publish` (idempotent, npm provenance) |
| `pypi` | 6 wheels via OIDC trusted publishing (`skip-existing`) |
| `images` | 5 multi-arch images on GHCR with provenance + SBOM, tagged `vYYYY.MM.DD[.N]`, `vYYYY.MM`, `latest` |
| `publish` | GitHub Release with binaries, `SHA256SUMS`, `install.sh`, `install.ps1` |

### Published artifacts

```
npm:    @caracalai/{core,oauth,admin,identity,revocation,sdk,
                    transport-mcp,transport-a2a,
                    mcp-express,mcp-fastmcp,tokenstate-postgres}
pypi:   caracalai-{core,identity,revocation,sdk,transport-mcp,fastmcp}
ghcr:   ghcr.io/garudex-labs/caracal-{api,sts,gateway,audit,coordinator}
```

### Rollback

Never delete a published tag. Roll forward.

| Surface | Action |
|---|---|
| npm | `npm deprecate "@caracalai/<pkg>@<bad>" "use <next>"`, cut a patch |
| PyPI | Yank on PyPI UI, cut a patch |
| Images | Re-cut; floating tags (`latest`, `vYYYY.MM`) move; call out bad pins in notes |
| GitHub Release | Mark pre-release or delete the Release object; cut a new CalVer |

### Local verification

```bash
pnpm -w build && pnpm -w test
pnpm changeset status
./scripts/release.sh --dry-run
pnpm -r --filter "@caracalai/*" pack --pack-destination /tmp/caracal-pack
```

## Security

Do not file public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

Apache-2.0. By contributing you agree your contribution is licensed under the same terms ([LICENSE](LICENSE)).
