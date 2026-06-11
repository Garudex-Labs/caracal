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
| Version               | `2026.06.04-dev.sha<sha>`                                | `2026.06.10-rc.1` / `0.1.5-rc.2`                          | `2026.06.04` / `0.1.4`                                    |
| Container images      | `localhost/caracal-{svc}:2026.06.04-dev.sha<sha>`        | `ghcr.io/garudex-labs/caracal-{svc}:v2026.06.10-rc.1`      | `ghcr.io/garudex-labs/caracal-{svc}:v2026.06.04`          |

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
pnpm caracal purge                  # Remove stack, volumes, logs, examples, cache, and installed data
```

`pnpm install` is the standard dependency install command for the Node workspace. Run `pnpm run setup` when you need the full cross-platform developer environment: it runs `pnpm install`, downloads Go module dependencies, creates `.venv`, installs Python test/style dependencies, and installs local Python packages in editable mode.

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

`pnpm caracal run -- <command>` reads validated runtime config from platform environment variables or an explicit runtime profile, exchanges the configured application credentials with STS, injects only the configured scoped resource-token environment variables into the child process, and executes without a shell. The stack does not create zones, applications, client secrets, or runtime profiles. Create a managed application with credential type `token`, copy the one-time client secret from the create result, and store the local secret and credential manifest under the OS Caracal config directory.

Run example workloads from their example directory:

```bash
cd examples/ResearchAgent
cp env.example .env
$EDITOR .env
. .env
pnpm caracal run -- node agent.mjs
```

The `.env` file contains only the zone and application identifiers. Local authentication still comes from the auto-detected app client secret at `${XDG_CONFIG_HOME:-$HOME/.config}/caracal/runtime/<zone-id>/<application-id>/client-secret`, and resource injection comes from the sibling `credentials.json` manifest.

#### Control API (optional)

The Console is the primary human product-management surface. The control service is an optional OAuth-protected HTTP API for approved external clients that need to drive Caracal programmatically.

Clients authenticate by exchanging the Control key credentials for a token whose audience matches `CONTROL_AUDIENCE`, which defaults to `caracal-control`. Create the key from the Console Control menu; Caracal generates `client_secret` and shows it once in the create result. Store it, then drive the enabled Control API from the workflow or client that will use it in production.

## Tests

```bash
pnpm run style                               # changed-file style gate
pnpm test                                    # full suite (ts + go + py)
pnpm run test:typescript | test:go | test:python
```

`scripts/testCi.sh` mirrors `.github/workflows/test.yml` locally:

```bash
scripts/testCi.sh                # full suite (style + ts + go + py + docs)
scripts/testCi.sh --smoke | --style | --go | --py | --ts
```

### Testing Policy

This policy is mandatory and is enforced during review:

- Major new functionality MUST add automated tests covering that functionality, in the same change that introduces it.
- Every bug fix MUST add a regression test that fails without the fix and passes with it.
- Reviewers MUST confirm the required tests exist and run in CI before approving; pull requests that omit them are not merged.

## Coding Style

Caracal uses the official language style conventions for its primary implementation languages:

| Language | Style guide | Automatic enforcement |
| --- | --- | --- |
| TypeScript and JavaScript | TypeScript Handbook style with the repository Prettier profile in `.prettierrc.json` | `pnpm run style` runs Prettier on changed TS/JS source files. |
| Go | Effective Go and `gofmt` formatting | `pnpm run style` runs `gofmt -l` on changed Go source files. |
| Python | PEP 8 layout as formatted by Ruff | `pnpm run style` runs `ruff format --check` on changed Python source files. |

Pull requests run the same style gate automatically for changed primary-language files. Use `pnpm run style:fix` to format changed files and `pnpm run style:all` before broad cleanup work.

## Submitting Changes

1. Create a branch from `main` and keep changes focused.
2. Keep the scope minimal (few files/components, small commits).
3. Run a quick local sanity check:
  - `pnpm caracal up`
  - `pnpm caracal status`
  - `pnpm caracal console`
  - `pnpm caracal down`
4. Ensure tests pass:
  - `pnpm run style`
  - `pnpm test`
  - `scripts/testCi.sh --smoke` (post-commit parity)
  - `scripts/testCi.sh` (daily-check parity)
5. Commit with a clear message and open a PR.

## Code Review

Every change is proposed as a pull request and reviewed before it is merged or released.

### How review is conducted

- Open a pull request against `main`; direct pushes to `main` are not used for code changes.
- At least one maintainer **other than the author** must review and approve the pull request before it is merged. Authors must not approve or merge their own changes.
- Area owners in `.github/CODEOWNERS` are requested automatically and own review for their paths.
- Release publishing requires `release-approval` from a maintainer other than the one who prepared the release.

### What reviewers must check

- **Correctness:** the change does what it claims and handles edge cases and failure paths.
- **Scope:** the change stays focused; unrelated edits are split out.
- **Tests:** the Testing Policy is satisfied — major new functionality adds tests and bug fixes add a regression test — and CI passes.
- **Style:** the change passes the `pnpm run style` gate for its languages.
- **Security and boundaries:** input is validated, secrets are not exposed, trust boundaries in `governance/THREAT_MODEL.md` are respected, and no open-source code depends on enterprise-only code.
- **Docs:** behavior, API, command, config, and operations changes update the affected documentation.

### What is required to be acceptable

A pull request is acceptable to merge only when it has at least one approving review from a non-author maintainer, all required CI checks pass, review comments are resolved, and the change is judged a worthwhile improvement free of known defects that would argue against inclusion.

## Releases

Release artifacts share one CalVer: `vYYYY.MM.DD` (`.N` for same-day re-cuts). Only `.github/MAINTAINERS` can run release workflows. Stable releases require `release-approval` from a different maintainer.

### Create dev builds

Use dev builds only for development:

```bash
pnpm --dir apps/runtime build:release                          # stamp dev + build local images + bun compile (all targets)
pnpm --dir apps/console build:release                          # stamp dev + bun compile (all targets)
BIN="$(pwd)/apps/runtime/dist/caracal-<os>-<arch>"                 # absolute path; survives cd
CONSOLE="$(pwd)/apps/console/dist/caracal-console-<os>-<arch>"         # Console binary; same OS/arch matrix
pnpm caracal down                                          # Stop dev before testing
    "$BIN" --version                                           # → caracal 2026.06.04-dev.sha<sha> [dev (sha <sha>)]
    "$CONSOLE" --version                                           # → caracal-console 2026.06.04-dev.sha<sha> [dev (sha <sha>)]
(cd /tmp && "$BIN" up && "$BIN" status && "$CONSOLE" && "$BIN" down)
```

`build:release` stamps dev binaries and local `localhost/caracal-{svc}:<base>-dev.sha<sha>` images. Do not use dev builds downstream.

### Native build flags

Go-based container builds preserve debug information by default and accept standard build arguments for native toolchains: `CGO_ENABLED`, `CC`, `CFLAGS`, `CXX`, `CXXFLAGS`, `LDFLAGS`, `GOFLAGS`, `GO_BUILDFLAGS`, and `GO_LDFLAGS`. The Dockerfiles add `-mod=readonly` and `-trimpath`; pass linker options through `GO_LDFLAGS` when a release or diagnostic build needs them.

### Release flow

Use the same flow for rc and stable: plan, dry-run, publish, validate. rc proves the exact artifacts downstream; stable promotes the approved release.

| Step | rc | stable |
| --- | --- | --- |
| Prepare | `scripts/release.sh rc prepare --base-version 2026.06.10 --suffix rc.1` | `scripts/release.sh stable --dry-run` |
| Review | Commit the generated manifest and metadata. | Review the stable diff and generated version. |
| Dry-run | `scripts/release.sh rc dry-run --base-version 2026.06.10 --suffix rc.1 --local` for local simulation; remote dry-run requires the rc commit on the selected ref. | `scripts/release.sh stable --dry-run` |
| Publish | Tag and push `v2026.06.10-rc.1`. | `scripts/release.sh stable` |
| Validate | `postReleaseValidation.yml` runs after release. | `postReleaseValidation.yml` gates stable promotion. |

```bash
# rc
scripts/release.sh rc prepare --base-version 2026.06.10 --suffix rc.1
git add -A && git commit -m "rc: v2026.06.10-rc.1"
scripts/release.sh rc dry-run --base-version 2026.06.10 --suffix rc.1 --local
git tag -a v2026.06.10-rc.1 -m v2026.06.10-rc.1
git push origin HEAD && git push origin v2026.06.10-rc.1

# stable
scripts/release.sh stable --dry-run
scripts/release.sh stable
```

Remote rc dry-runs dispatch `release.yml` without publishing. They only read the default branch or the exact release tag ref, and the working tree must be clean unless `--allow-dirty` is used deliberately.

### Post-release validation

`postReleaseValidation.yml` checks registries, archives, installers, containers, and provenance. npm, PyPI, binary, and installer checks cover Ubuntu, macOS, and Windows.

Reproduce one area locally:

```bash
CARACAL_RELEASE=v2026.06.10-rc.1 FINDINGS_DIR=/tmp/findings \
  bash scripts/postRelease/validateRegistryMetadata.sh
```

### Package publishing

```bash
pnpm release:plan --since v2026.05.14
pnpm release:stamp:check
gh workflow run publishNpm.yml -f package=changed -f dryRun=true -f runner=ubuntu-24.04
gh workflow run publishNpm.yml -f package=changed -f runner=ubuntu-24.04
gh workflow run publishPypi.yml -f package=changed -f dryRun=true -f runner=ubuntu-24.04
gh workflow run publishPypi.yml -f package=changed -f runner=ubuntu-24.04
```

Protected workflows are the normal path for npm and PyPI. They read `release.config.json`, ignore `examples/**`, publish changed packages, include exact-pin dependents, preflight Ubuntu/macOS/Windows, and publish once from the selected `runner`. Use `baseRef` to override the diff base and `package=all` only for deliberate full publishes. Local stable publishing requires approval and `CARACAL_ALLOW_LOCAL_STABLE_PUBLISH=1`.

### Published artifacts

```
npm:    @caracalai/{core,oauth,admin,identity,revocation,sdk,
                    transport-mcp,transport-a2a,
                    mcp-express,mcp-fastmcp,tokenstate-postgres,revocation-redis}
pypi:   caracalai-{core,oauth,identity,revocation,sdk,transport-mcp,mcp-fastmcp,revocation-redis}
ghcr:   ghcr.io/garudex-labs/caracal-{api,sts,gateway,audit,coordinator,redis}
```

Browse: [npm](https://www.npmjs.com/~caracal-run) · [PyPI](https://pypi.org/user/CaracalAI).

### Rollback

Never delete a published tag. Roll forward with a new CalVer tag. The floating `vYYYY.MM` image tag moves with the new cut; pinned `v<calver>` tags are immutable.

## Security

Do not file public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

Apache-2.0. By contributing you agree your contribution is licensed under the same terms ([LICENSE](../LICENSE)).
