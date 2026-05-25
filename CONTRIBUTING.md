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
pnpm caracal --help                 # Show runtime shell help and available lifecycle commands
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

#### Console

```bash
pnpm caracal console          # Human-facing product management
```

#### Standalone execution

`pnpm caracal run -- <command>` reads `caracal.toml`, exchanges the configured application credentials with STS, injects only the configured scoped resource-token environment variables into the child process, and executes without a shell.

```bash
pnpm caracal run -- <command> # Example: -- node examples/agent.js
```

#### Control API (optional)

The control service is an OAuth-protected HTTP API hosted by the engine for any external client that needs to drive Caracal programmatically.

Clients authenticate by exchanging the Control key credentials for a token whose resource matches the control audience (`caracal control`). Create the key from the Console Control menu; Caracal generates `client_secret` and shows it once in the create result. Store it, then drive the enabled Control API from the workflow or client that will use it in production.

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
  - `pnpm caracal console`
  - `pnpm caracal down`
4. Ensure tests pass:
  - `pnpm test`
  - `scripts/testCi.sh --smoke` (post-commit parity)
  - `scripts/testCi.sh` (daily-check parity)
5. Commit with a clear message and open a PR.

## Releases

Release artifacts share one CalVer: `vYYYY.MM.DD` (suffix `.N` for same-day re-cuts). Only maintainers listed in `.github/MAINTAINERS` may cut releases. Stable release publication is gated by the protected `release-approval` GitHub Environment and must be approved by a maintainer other than the actor who pushed the tag.

### Create dev builds

Use dev builds only for development:

```bash
pnpm --dir apps/runtime build:release                          # stamp dev + build local images + bun compile (all targets)
pnpm --dir apps/console build:release                          # stamp dev + bun compile (all targets)
BIN="$(pwd)/apps/runtime/dist/caracal-<os>-<arch>"                 # absolute path; survives cd
CONSOLE="$(pwd)/apps/console/dist/caracal-console-<os>-<arch>"         # Console binary; same OS/arch matrix
pnpm caracal down                                          # Stop dev before testing
"$BIN" --version                                           # → caracal 2026.05.14-dev.sha<sha> [dev (sha <sha>)]
"$CONSOLE" --version                                           # → caracal-console 2026.05.14-dev.sha<sha> [dev (sha <sha>)]
(cd /tmp && "$BIN" up && "$BIN" status && "$CONSOLE" && "$BIN" down)
```

The local `build:release` stamps the binary with `CARACAL_VERSION=<base>-dev.sha<sha>` and `CARACAL_REGISTRY=localhost/`, then runs `docker compose build` to produce matching `localhost/caracal-{svc}:<base>-dev.sha<sha>` images. This path is not for downstream third-party consumption.

### Create and publish rc

Use rc when a downstream project must consume Caracal exactly like a third-party dependency before stable:

```bash
scripts/rc.sh prepare                         # write manifest and stamp Helm/package metadata to rc versions
git add -A && git commit -m "rc: vYYYY.MM.DD-rc.sha<sha>"
git tag -a vYYYY.MM.DD-rc.sha<sha> -m vYYYY.MM.DD-rc.sha<sha>
git push origin HEAD && git push origin vYYYY.MM.DD-rc.sha<sha>
```

### Create and publish stable

```bash
scripts/release.sh               # applies changesets, stamps Helm metadata, computes CalVer, tags, pushes stable
scripts/release.sh --dry-run     # preview stable without tagging
```

Pushing the tag triggers `.github/workflows/release.yml`. Stable GitHub Release creation waits for `release-approval`; configure the repository so `v*` tags are protected from deletion and force-push.

### Post-release validation

`postReleaseValidation.yml` runs automatically after `release.yml` succeeds. It exercises registries, archives, installers, containers, and provenance, then opens a PR with `releases/<tag>/validation.md`.

Reproduce one area locally:

```bash
CARACAL_RELEASE=v2026.05.14 FINDINGS_DIR=/tmp/findings \
  bash scripts/postRelease/validateRegistryMetadata.sh
```

### Publishing to npm and PyPI

```bash
gh workflow run publishNpm.yml -f package=changed -f dryRun=true
gh workflow run publishNpm.yml -f package=changed
gh workflow run publishPypi.yml -f package=changed -f dryRun=true
gh workflow run publishPypi.yml -f package=changed
```

Protected workflows are the normal release path. They diff the current `HEAD` against the latest reachable release tag and select only changed publishable package directories. Use `baseRef` to override the diff base or `package=all` only for an intentional full-package publish. Local scripts remain available for RC publishing and emergency recovery, but stable local publishing requires `CARACAL_ALLOW_LOCAL_STABLE_PUBLISH=1` after release approval.

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
