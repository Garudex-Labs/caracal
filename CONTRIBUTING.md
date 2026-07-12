# Contributing to Caracal

<details>
<summary>Prerequisites</summary>

| Tool                | Version |
| ------------------- | ------- |
| Node.js             | 24+     |
| pnpm                | 11.1.1  |
| Docker + Compose v2 | 25+     |
| Go                  | 1.26+   |
| Python              | 3.14+   |
| Bun                 | 1.3.14  |

- `<os>` ∈ `linux` · `darwin` · `windows`
- `<arch>` ∈ `x64` · `arm64`

</details>

<details>
<summary>Modes</summary>

|                       | Dev                                                      | RC                                                          | Stable                                                     |
| --------------------- | -------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| Purpose               | Development builds                                      | rc builds                                                   | Released production versions                               |
| Version               | `0.2.0-dev.sha<sha>`                                     | `0.2.0-rc.3`                                                | `0.2.0`                                                    |
| Container images      | `localhost/caracal-{svc}:0.2.0-dev.sha<sha>`             | `ghcr.io/garudex-labs/caracal-{svc}:v0.2.0-rc.3`            | `ghcr.io/garudex-labs/caracal-{svc}:v0.2.0`                |

</details>

## Setup

```bash
git clone https://github.com/Garudex-Labs/caracal.git && cd caracal
pnpm run setup                       # Install workspace and language dependencies
pnpm caracal up                     # Build and start the Caracal platform

# Essential Commands
pnpm caracal --help                 # Show CLI help and available commands
pnpm caracal status                 # Show platform health
pnpm caracal down [--help]          # Stop the platform (-v removes volumes)
pnpm caracal purge                  # Remove platform state (stack, volumes, logs, config, cache)
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

`pnpm caracal run -- <command>` authenticates as a workload, fetches its launch bindings from STS, injects scoped resource credentials into the child process, and runs it directly (no shell). It does not create workloads, secrets, zones, or bindings. Create a workload on the Launcher page in the web console, save the one-time workload secret to the runtime secret path, and author the launch bindings on the same page.

Run example workloads from a clone of the [Caracal examples repository](https://github.com/Garudex-Labs/examples):

```bash
git clone https://github.com/Garudex-Labs/examples.git caracal-examples
cd caracal-examples/ResearchAgent
cp env.example .env
$EDITOR .env
. .env
pnpm caracal run -- node agent.mjs
```

On Windows, source the `.env` file from Git Bash or WSL, or set the same variables in PowerShell with `$env:NAME = "value"` before `pnpm caracal run`.

#### Control API (optional)

The web console is the primary management interface for Caracal. The Control API is an optional OAuth-protected endpoint for approved external automation and can be managed from the **Control** page.

## Tests

```bash
pnpm run style                               # changed-file style gate
pnpm test                                    # full suite (ts + go + py)
pnpm run test:typescript                     # TypeScript suite
pnpm run test:go                             # Go suite
pnpm run test:python                         # Python suite
```

`scripts/testCi.sh` mirrors `.github/workflows/test.yml` locally:

```bash
scripts/testCi.sh                # full suite (style + ts + go + py + docs)
scripts/testCi.sh --smoke        # workspace build and Go vet
```

The script also accepts `--all`, `--style`, `--ts`, `--go`, `--py`, and `--docs`.

### Testing Policy

This policy is mandatory and is enforced during review:

- Major new functionality MUST add automated tests covering that functionality, in the same change that introduces it.
- Every bug fix MUST add a regression test that fails without the fix and passes with it.
- Reviewers MUST confirm the required tests exist and run in CI before approving; pull requests that omit them are not merged.

## Coding Style

Caracal follows standard language conventions: TypeScript/JavaScript (TypeScript + Prettier), Go (Effective Go + `gofmt`), and Python (PEP 8 + Ruff).

The style gate always formats with the same pinned toolchain CI checks against: Prettier from the workspace lockfile, `gofmt`, and the Ruff version pinned in `scripts/pythonStyleRequirements.in` (installed into the repository venv on demand). `pnpm install` activates the repository pre-commit hook (`.githooks/pre-commit`), which formats and restages staged source files on every commit. Use `pnpm run style` to validate unpushed work and `pnpm run style:fix` to format manually.


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

Every change is proposed as a pull request against `main` and reviewed before merge.

### How review is conducted

- At least one maintainer other than the author must approve each pull request. Authors must not approve or merge their own changes.
- Maintainers are listed in `.github/CODEOWNERS`, so they are requested automatically.
- Stable release publishing requires `release-approval` from a maintainer other than the one who prepared the release.

### What reviewers must check

- **Correctness:** the change does what it claims and handles edge cases and failure paths.
- **Scope:** the change stays focused; unrelated edits are split out.
- **Tests:** the Testing Policy is satisfied - major new functionality adds tests and bug fixes add a regression test - and CI passes.
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

A pull request is acceptable to merge only when it has at least one approving review from a maintainer other than the author, all required CI checks pass, review comments are resolved, and the change is judged a worthwhile improvement free of known defects that would argue against inclusion.

## Releases

Every artifact in a release shares one Semantic Version: `product.version` in `release.config.json` (`vX.Y.Z`, rc trains use `vX.Y.Z-rc.N`). Only `.github/MAINTAINERS` can run release workflows. Stable releases require `release-approval` from a different maintainer.

### Create dev builds

Use dev builds only for development:

```bash
pnpm --dir apps/runtime build:release                          # stamp dev + build local images + bun compile (all targets)
BIN="$(pwd)/apps/runtime/dist/caracal-<os>-<arch>"                 # absolute path; survives cd
pnpm caracal down                                          # Stop dev before testing
    "$BIN" --version                                           # → caracal 0.2.0-dev.sha<sha> [dev (sha <sha>)]
(cd /tmp && "$BIN" up && "$BIN" status && "$BIN" down)
```

`build:release` stamps dev binaries and local `localhost/caracal-{svc}:<base>-dev.sha<sha>` images. Do not use dev builds downstream.

### Native build flags

Go-based container builds strip debug symbols by default (`GO_LDFLAGS` defaults to `-s -w`) and accept standard build arguments for native toolchains: `CGO_ENABLED`, `CC`, `CFLAGS`, `CXX`, `CXXFLAGS`, `LDFLAGS`, `GOFLAGS`, `GO_BUILDFLAGS`, and `GO_LDFLAGS`. The Dockerfiles add `-mod=readonly` and `-trimpath`; override `GO_LDFLAGS` when a diagnostic build needs symbol tables.

### Release flow

Use the same flow for rc and stable: plan, dry-run, publish, validate. An rc proves the release architecture downstream; stable rebuilds from the approved source with stable version metadata.

| Step | rc | stable |
| --- | --- | --- |
| Prepare | Set `product.version` to `X.Y.Z-rc.N` in `release.config.json`, then `scripts/release.sh rc prepare` | `scripts/release.sh promote --from vX.Y.Z-rc.N`, then review and commit |
| Review | Commit the stamped files, manifest, and metadata. | Commit the stamped files and review the stable diff. |
| Dry-run | Run `scripts/release.sh rc dry-run --local`, then `scripts/release.sh rc dry-run` from the pushed commit. | Run `scripts/release.sh stable --dry-run --local`, then `scripts/release.sh stable --dry-run` from the pushed commit. |
| Publish | `scripts/release.sh rc publish` | `scripts/release.sh stable` |
| Validate | Pre-publish gate proves artifacts before the tag is published. | Pre-publish gate proves artifacts before stable promotion. |

Remote dry-runs dispatch `release.yml` without publishing. They only read the default branch or the exact release tag ref, and the working tree must be clean. Publication is blocked until that exact commit has a successful release dry run.

### Release validation

Validation happens before publishing. On its first invocation, the local publish command atomically creates the root and nested Go tags and queues a dry run whose workflow definition and checkout both come from that immutable tag commit. After that dry run succeeds, invoke the same publish command again to queue publication. The `context` job verifies every tag target, the release plan, and version stamps. `archives` binds the published manifest to the full tag commit, proves reproducible packaging, runs binary smoke tests, generates checksums, and attaches provenance. The npm and PyPI `preflight` jobs build and pack-check every package on Ubuntu, macOS, and Windows before any publish step runs. Publish retries reuse only exact-provenance artifacts.

`scripts/release.sh rc prepare`, `stable`, and `promote` also write the docs Releases record (`docs/src/data/releases/<tag>.json`) from the release plan. CI finalizes the customer manifest from the immutable tag commit; a preparation checkout never claims the identity of a commit that does not exist yet.

### Package publishing

```bash
pnpm release:plan
pnpm release:stamp:check
gh workflow run publishNpm.yml -f package=all -f dryRun=true -f runner=ubuntu-24.04
gh workflow run publishPypi.yml -f package=all -f dryRun=true -f runner=ubuntu-24.04
```

The root release workflow owns production publication. npm package workflow dispatches are dry-run only. PyPI production publication is dispatched by the release orchestrator through the protected `publishPypi.yml` Trusted Publisher workflow with an exact release tag and source SHA. The local publisher supports TestPyPI only. The workflows read `release.config.json`, publish every package at the shared version, preflight Ubuntu/macOS/Windows, and publish once from the selected `runner`. A retry reuses an existing package, image, chart, or GitHub Release only after its digest and provenance verify against the exact release tag and commit. Any mismatch consumes the version and requires a roll-forward release.

PyPI publication is dispatched directly through `publishPypi.yml`, matching its Trusted Publisher identity. If a release stops after some immutable artifacts are public, `resumeRelease.yml` verifies the original release-assets artifact and every npm, PyPI, OCI, and Helm artifact before creating the missing GitHub Release. It never rebuilds or replaces an existing artifact.

### Published artifacts

```
npm:    @caracalai/{core,oauth,admin,identity,revocation,sdk,
                    verify,express,fastmcp,revocation-redis}
pypi:   caracalai-{core,oauth,admin,identity,revocation,sdk,verify,fastmcp,asgi,revocation-redis}
ghcr:   ghcr.io/garudex-labs/caracal-{go,node,web,postgres,redis,runtime}
```

Browse: [npm](https://www.npmjs.com/~caracal-run) · [PyPI](https://pypi.org/user/CaracalAI).

### Rollback

Never delete a published tag. Roll forward with a new SemVer tag. The floating `vX.Y` image tag moves with the new cut; pinned `vX.Y.Z` tags are immutable.

## Security

Do not file public issues for vulnerabilities. See [SECURITY.md](.github/SECURITY.md).

## License

Apache-2.0. By contributing you agree your contribution is licensed under the same terms ([LICENSE](LICENSE)).
