# Contributing to Caracal

<details>
<summary>Prerequisites</summary>

| Tool                | Version |
| ------------------- | ------- |
| Node.js             | 24+     |
| pnpm                | 11.1.1  |
| Docker + Compose v2 | 24+     |
| Go                  | 1.26+   |
| Python              | 3.14+   |
| Bun                 | latest  |

- `<os>` ∈ `linux` · `darwin` · `windows`
- `<arch>` ∈ `x64` · `arm64`

</details>

<details>
<summary>Modes</summary>

|                       | Dev                                                      | RC                                                          | Stable                                                     |
| --------------------- | -------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| Purpose               | Development builds                                      | rc builds                                                   | Released production versions                               |
| Version               | `2026.05.14-dev.sha<sha>`                                | `2026.05.14-rc.sha<sha>` / `1.4.2-rc.1`                    | `2026.05.14` / `1.4.2`                                    |
| Container images      | `localhost/caracal-{svc}:2026.05.14-dev.sha<sha>`        | `ghcr.io/garudex-labs/caracal-{svc}:v2026.05.14-rc.sha<sha>` | `ghcr.io/garudex-labs/caracal-{svc}:v2026.05.14`        |

</details>

## Setup

```bash
git clone https://github.com/Garudex-Labs/caracal.git && cd caracal
pnpm install
pnpm caracal up                     # Build and start the full stack

# Essential Commands
pnpm caracal --help                 # Show CLI help and available commands
pnpm caracal status                 # Check health status of all services
pnpm caracal down [--help]          # Stop the stack
pnpm caracal purge                  # Remove stack, volumes, logs, cache, and installed data
```

<details>
<summary>Drop the `pnpm` prefix</summary>

```bash
pnpm link --global            # Install global symlink
pnpm unlink --global caracal  # Remove global symlink
```

</details>

#### CLI

```bash
pnpm caracal cli
pnpm --dir apps/cli typecheck
```

#### TUI

```bash
pnpm caracal tui
```

CLI and TUI are exact alternatives over the same engine.

#### Control API (optional)

The control service is an OAuth-protected HTTP API hosted by the engine for any external client (script, AI agent, workflow, or another instance of CLI/TUI) that needs to drive Caracal programmatically. It is off by default.

The control service reads its admin token from `infra/secrets/files/caracalAdminToken`, which is generated on the first `pnpm caracal up` or `pnpm secrets:init`. Run one of those before starting the control surface.

```bash
docker compose --env-file infra/docker/dev.env -f infra/docker/docker-compose.yml --profile control up --build control
```

If you created `infra/docker/local.env` for operator overrides, pass it after `dev.env` so local entries win.

Clients authenticate by exchanging the zone application credentials for a token whose resource matches the control audience (`caracal-control` by default).

```bash
# set these from caracal.toml; local dev defaults STS to http://localhost:8080
ZONE_URL=${ZONE_URL:-http://localhost:8080}
: "${ZONE_ID:?set ZONE_ID from caracal.toml zone_id}"
: "${APP_CLIENT_ID:?set APP_CLIENT_ID from caracal.toml application_id}"
: "${APP_CLIENT_SECRET:?set APP_CLIENT_SECRET from caracal.toml app_client_secret}"

# mint a token (use the zone/application values from caracal.toml)
TOKEN=$(curl -fsS -X POST "${ZONE_URL%/}/oauth/2/token" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "zone_id=$ZONE_ID" \
  -d "application_id=$APP_CLIENT_ID" \
  -d "client_secret=$APP_CLIENT_SECRET" \
  -d "resource=caracal-control" \
  -d "scope=control:zone:read" \
  | jq -er .access_token)
: "${TOKEN:?token mint failed}"

# invoke
curl -sH "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command":"zone","subcommand":"list"}' \
  http://localhost:8087/v1/control/invoke
```

## Tests

```bash
pnpm test                                    # full suite (ts + go + py)
pnpm run test:typescript | test:go | test:python
```

`scripts/testCi.sh` mirrors `.github/workflows/test.yml` locally:

```bash
scripts/testCi.sh                # full suite (ts + go + py + docs)
scripts/testCi.sh --smoke | --go | --py | --ts
```

## Submitting Changes

1. Create a branch from `main` and keep changes focused.
2. Keep the scope minimal (few files/components, small commits).
3. Run a quick local sanity check:
  - `pnpm caracal up`
  - `pnpm caracal status`
  - `pnpm caracal cli`
  - `pnpm caracal tui`
4. Ensure tests pass:
  - `pnpm test`
  - `scripts/testCi.sh --smoke` (post-commit parity)
  - `scripts/testCi.sh` (daily-check parity)
5. Commit with a clear message and open a PR.

## Releases

Release artifacts share one CalVer: `vYYYY.MM.DD` (suffix `.N` for same-day re-cuts). Only maintainers listed in `.github/MAINTAINERS` may cut releases.

### Create dev builds

Use dev builds only for development:

```bash
pnpm --dir apps/cli build:release                          # stamp dev + build local images + bun compile (all targets)
pnpm --dir apps/tui build:release                          # stamp dev + bun compile (all targets)
BIN="$(pwd)/apps/cli/dist/caracal-cli-<os>-<arch>"         # absolute path; survives cd
TUI="$(pwd)/apps/tui/dist/caracal-tui-<os>-<arch>"         # TUI binary; same OS/arch matrix
pnpm caracal down                                          # Stop dev before testing
"$BIN" --version                                           # → caracal 2026.05.14-dev.sha<sha> [dev (sha <sha>)]
"$TUI" --version                                           # → caracal-tui 2026.05.14-dev.sha<sha> [dev (sha <sha>)]
(cd /tmp && "$BIN" up && "$BIN" status && "$TUI" && "$BIN" down)
```

The local `build:release` stamps the binary with `CARACAL_VERSION=<base>-dev.sha<sha>` and `CARACAL_REGISTRY=localhost/`, then runs `docker compose build` to produce matching `localhost/caracal-{svc}:<base>-dev.sha<sha>` images. This path is not for downstream third-party consumption.

### Create and publish rc

Use rc when a downstream project must consume Caracal exactly like a third-party dependency before stable:

```bash
scripts/rc.sh prepare                         # write manifest and stamp package metadata to rc versions
git add -A && git commit -m "rc: vYYYY.MM.DD-rc.sha<sha>"
git tag -a vYYYY.MM.DD-rc.sha<sha> -m vYYYY.MM.DD-rc.sha<sha>
git push origin HEAD && git push origin vYYYY.MM.DD-rc.sha<sha>
```

Use `scripts/rc.sh version` only to preview a manifest without stamping package metadata; clean that preview with `scripts/rc.sh clean --manifest <manifest-path>`.

Pushing an rc tag runs `.github/workflows/release.yml`, publishes OCI images to GHCR, and creates a GitHub Release for rc. npm packages publish with the `rc` dist-tag through `scripts/publishNpm.sh`; PyPI packages publish with PEP 440 rc versions through `scripts/publishPypi.sh`.

Switch a downstream repo between rc and stable by changing only the Caracal versions it already consumes:

```bash
npm install @caracalai/sdk@1.4.2-rc.sha<sha>      # rc
npm install @caracalai/sdk@1.4.2                  # stable
uv add caracalai-sdk==1.4.2rc0+sha<sha>           # rc
uv add caracalai-sdk==1.4.2                       # stable
```

For containers, change only `ghcr.io/garudex-labs/caracal-{svc}:v<version>`. For binaries, install the desired `--version`. Do not add `file:../caracal`, editable Caracal installs, Docker `COPY` from this checkout, Caracal source paths, or extra consumer env files.

### Create and publish stable

```bash
scripts/release.sh               # applies changesets, computes CalVer, tags, pushes stable
scripts/release.sh --dry-run     # preview stable without tagging
```

Pushing the tag triggers `.github/workflows/release.yml`

### Post-release validation

`postReleaseValidation.yml` runs automatically after `release.yml` succeeds. It exercises registries, archives, installers, containers, and provenance, then opens a PR with `releases/<tag>/validation.md`.

Reproduce one area locally:

```bash
CARACAL_RELEASE=v2026.05.14 FINDINGS_DIR=/tmp/findings \
  bash scripts/postRelease/validateRegistryMetadata.sh
```

### Publishing to npm and PyPI

```bash
./scripts/publishNpm.sh
./scripts/publishPypi.sh             # PyPI
./scripts/publishPypi.sh --testpypi   # TestPyPI
```

Skips versions already published. `scripts/publishNpm.sh` publishes rc versions with the `rc` dist-tag and stable versions with `latest`. Both scripts refuse dev-stamped versions (`-dev.sha<sha>`).

### Published artifacts

```
npm:    @caracalai/{core,oauth,admin,identity,revocation,sdk,
                    transport-mcp,transport-a2a,
                    mcp-express,mcp-fastmcp,tokenstate-postgres,revocation-redis}
pypi:   caracalai-{core,identity,revocation,sdk,transport-mcp,mcp-fastmcp,revocation-redis}
ghcr:   ghcr.io/garudex-labs/caracal-{api,sts,gateway,audit,coordinator,redis}
```

Browse: [npm](https://www.npmjs.com/~caracal-run) · [PyPI](https://pypi.org/user/CaracalAI).

### Rollback

Never delete a published tag. Roll forward with a new CalVer tag. The floating `vYYYY.MM` image tag moves with the new cut; pinned `v<calver>` tags are immutable.

## Security

Do not file public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

Apache-2.0. By contributing you agree your contribution is licensed under the same terms ([LICENSE](LICENSE)).
