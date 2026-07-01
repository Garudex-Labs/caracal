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
| Version               | `2026.06.04-dev.sha<sha>`                                | `2026.06.25-rc.1` / `0.1.6-rc.2`                          | `2026.06.04` / `0.1.4`                                    |
| Container images      | `localhost/caracal-{svc}:2026.06.04-dev.sha<sha>`        | `ghcr.io/garudex-labs/caracal-{svc}:v2026.06.25-rc.1`      | `ghcr.io/garudex-labs/caracal-{svc}:v2026.06.04`          |

</details>

## Setup

```bash
git clone https://github.com/Garudex-Labs/caracal.git && cd caracal
pnpm caracal up                     # Build and start the full stack

# Essential Commands
pnpm caracal --help                 # Show runtime shell help and available lifecycle commands
pnpm caracal status                 # Check health status of all services
pnpm caracal down [--help]          # Stop the stack
pnpm caracal purge                  # Remove stack, volumes, logs, examples, cache, and installed data
```

<details>
<summary>Drop the `pnpm` prefix</summary>

```bash
pnpm link --global            # Install global symlink
pnpm unlink --global caracal  # Remove global symlink
```

</details>

#### Web console

```bash
pnpm caracal web              # Human-facing product management in the browser
```

#### Standalone execution

`pnpm caracal run -- <command>` loads runtime config, exchanges application credentials with STS, injects scoped resource tokens into the child process, and runs it directly (no shell). It does not create apps, secrets, zones, or profiles. Create a managed `token` application first, save the one-time client secret, and store credentials in the OS Caracal config directory.

Run example workloads from their example directory:

```bash
cd examples/ResearchAgent
cp env.example .env
$EDITOR .env
. .env
pnpm caracal run -- node agent.mjs
```

#### Control API (optional)

The web console is the primary management interface for Caracal. The Control API is an optional OAuth-protected endpoint for approved external automation and can be managed from the **web console → Runtime → Control** item.


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

Caracal follows standard language conventions: TypeScript/JavaScript (TypeScript + Prettier), Go (Effective Go + `gofmt`), and Python (PEP 8 + Ruff). 

Style checks run automatically in pull requests, with `pnpm run style` for validation and `pnpm run style:fix` for automatic formatting.


## Submitting Changes

1. Create a branch from `main` and keep changes focused.
2. Keep the scope minimal (few files/components, small commits).
3. Run a quick local sanity check:
  - `pnpm caracal up`
  - `pnpm caracal status`
  - `pnpm caracal web`
  - `pnpm caracal down`
4. Ensure tests pass:
  - `pnpm run style`
  - `pnpm test`
  - `scripts/testCi.sh --smoke` (post-commit parity)
  - `scripts/testCi.sh` (daily-check parity)
5. Commit with a clear message and open a PR.

## Code Review

Changes are proposed against `main`, and the review required to merge depends on the contributor's role.

### How review is conducted

- Repository admins may push directly to `main`.
- Maintainers listed in `.github/MAINTAINERS` open a pull request but may merge it without a separate approving review.
- All other contributors open a pull request that requires at least one approving review from a maintainer before it is merged. Authors must not approve or merge their own changes.
- Maintainers are listed in `.github/CODEOWNERS`, so they are requested automatically and their approval is required to merge a contributor pull request.
- Release publishing requires `release-approval` from a maintainer other than the one who prepared the release.

### What reviewers must check

- **Correctness:** the change does what it claims and handles edge cases and failure paths.
- **Scope:** the change stays focused; unrelated edits are split out.
- **Tests:** the Testing Policy is satisfied — major new functionality adds tests and bug fixes add a regression test — and CI passes.
- **Style:** the change passes the `pnpm run style` gate for its languages.
- **Security and boundaries:** input is validated, secrets are not exposed, trust boundaries in `governance/THREAT_MODEL.md` are respected, and no open-source code depends on enterprise-only code.
- **Docs:** behavior, API, command, config, and operations changes update the affected documentation.

### Reviewing dependency changes

Dependency changes get extra scrutiny because they are a common supply-chain attack vector.

- A scheduled dependency review runs every two days over the changes merged to `main` in that window and fails on newly introduced High-or-higher vulnerabilities and on a copyleft license deny-list.
- Confirm a lockfile change accompanies every manifest change so installs stay pinned (`pnpm-lock.yaml`, `go.sum`, Python `*.lock`).
- For a new or upgraded dependency, check that the package is the expected one (no typosquats), is actively maintained, and that the version bump is explained.
- Dependabot pull requests follow the same review and CI as any other change; do not merge them solely because they are automated.
- See the [Enterprise Security Readiness](https://docs.caracal.run/security/enterprise-readiness/) guide for the full supply-chain posture.

### What is required to be acceptable

A contributor pull request is acceptable to merge only when it has at least one approving review from a maintainer, all required CI checks pass, review comments are resolved, and the change is judged a worthwhile improvement free of known defects that would argue against inclusion. Maintainers and admins are trusted to hold the changes they merge directly to the same standard.

## Releases

Release artifacts share one CalVer: `vYYYY.MM.DD` (`.N` for same-day re-cuts). Only `.github/MAINTAINERS` can run release workflows. Stable releases require `release-approval` from a different maintainer.

### Create dev builds

Use dev builds only for development:

```bash
pnpm --dir apps/runtime build:release                          # stamp dev + build local images + bun compile (all targets)
BIN="$(pwd)/apps/runtime/dist/caracal-<os>-<arch>"                 # absolute path; survives cd
pnpm caracal down                                          # Stop dev before testing
    "$BIN" --version                                           # → caracal 2026.06.04-dev.sha<sha> [dev (sha <sha>)]
(cd /tmp && "$BIN" up && "$BIN" status && "$BIN" down)
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
| Publish | Tag and push `v2026.06.25-rc.1`. | `scripts/release.sh stable` |
| Validate | Pre-publish gate proves artifacts before the tag is published. | Pre-publish gate proves artifacts before stable promotion. |

```bash
# rc
scripts/release.sh rc prepare --base-version 2026.06.10 --suffix rc.1
git add -A && git commit -m "rc: v2026.06.25-rc.1"
scripts/release.sh rc dry-run --base-version 2026.06.10 --suffix rc.1 --local
git tag -a v2026.06.25-rc.1 -m v2026.06.25-rc.1
git push origin HEAD && git push origin v2026.06.25-rc.1

# stable
scripts/release.sh stable --dry-run
scripts/release.sh stable
```

Remote rc dry-runs dispatch `release.yml` without publishing. They only read the default branch or the exact release tag ref, and the working tree must be clean unless `--allow-dirty` is used deliberately.

### Release validation

Validation happens before publishing. The `context` job verifies the release manifest, version stamps, and changeset state; `archives` proves reproducible builds, runs binary smoke tests, generates checksums, and attaches provenance; the npm and PyPI `preflight` jobs build and pack-check every package on Ubuntu, macOS, and Windows before any publish step runs. The publish jobs then self-verify that each version is live on its registry.

`scripts/release.sh rc prepare`, `stable`, and `promote` also write the docs Releases record (`docs/src/data/releases/<tag>.json`) from the manifest, so release evidence is committed with the release rather than generated afterward.

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
