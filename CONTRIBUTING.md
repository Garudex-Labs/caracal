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
pnpm caracal purge                  # Remove stack, volumes, logs, cache, and runtime data
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

```bash
docker compose --profile control up control   # start the surface (CARACAL_CONTROL_ENABLED=true)
```

Clients authenticate with a standard OAuth2 client-credentials flow against STS.

```bash
# mint a token (any OAuth2 client; CLI/TUI use their caracal.toml app creds)
curl -sX POST "$ZONE_URL/oauth/2/token" \
  -u "$APP_CLIENT_ID:$APP_CLIENT_SECRET" \
  -d "grant_type=client_credentials&scope=control:invoke" | jq -r .access_token

# invoke
curl -sH "Authorization: Bearer $TOKEN" \
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

Switch a downstream repo to an rc without exposing this source tree:

```bash
scripts/rc.sh select --manifest releases/vYYYY.MM.DD-rc.sha<sha>/manifest.json --consumer /path/to/downstream
scripts/rc.sh revert --consumer /path/to/downstream
```

`select` writes exact package versions and registry/index endpoints only. It must not introduce `file:../caracal`, editable Caracal installs, Docker `COPY` from this checkout, or Caracal source paths.

The selector refreshes recognized lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `uv.lock`, or `poetry.lock`) against the selected registry/index endpoints. Use `--skip-lock-refresh` only when the consumer repo intentionally manages lock refresh in its own CI job. The selector saves the previous downstream state in `.caracalRcState.json` so `revert` can restore official dependency versions and endpoint configuration.

Switch a downstream repo back to stable by reverting the rc selection and installing the stable package versions from the standard registry/index endpoints.

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
