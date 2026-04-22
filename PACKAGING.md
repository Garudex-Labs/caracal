# Caracal Distribution Packaging Audit

This document is the output of Phase 0 / P0.1 of the Lynx Capital
demo build plan. It inventories the **published surface** Caracal
exposes to a real adopter today, the **monorepo paths** that surface
secretly depends on, and the **gap** between the two. It is the
basis for the restructure work in P0.2 onward.

The audit was performed against the current `main` revision of this
repository.

---

## 1. Artifacts a real user needs end to end

These are the things an external adopter must be able to acquire and
run from outside the Caracal monorepo to use Caracal in production:

| Artifact                              | Purpose                                                        | Current source                                                 |
| ------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| `caracal` CLI                         | Workspace, principal, provider, policy, authority, delegation. | `caracal/cli/main.py`, exposed via `caracal-core` PyPI script. |
| `caracal` host orchestrator           | `up`, `down`, `reset`, `purge`, `logs`, `cli`, `flow`.         | `caracal/runtime/entrypoints.py:caracal_entrypoint`.           |
| `caracal` TUI ("Flow")                | Interactive workspace operator.                                | `caracal/flow/`.                                               |
| `caracal_sdk` Python package          | Programmatic enforcement: `CaracalClient.tools.call(...)`.     | `sdk/python-sdk/src/caracal_sdk/` (`caracal-sdk` on PyPI).     |
| Runtime container image               | Server (`mcp`), HTTP API, AIS, migrations, entrypoint scripts. | Built from repo Dockerfiles; no canonical published tag.       |
| Vault sidecar image                   | Secret storage backing principal / mandate keys.               | `infisical/infisical:latest` referenced from compose only.     |
| PostgreSQL service                    | Primary store.                                                 | `postgres:16-alpine` from compose only.                        |
| Redis service                         | Caches, revocation channel, AIS coordination.                  | `redis:7-alpine` from compose only.                            |
| Docker Compose bundle                 | Brings the four services up coherently.                        | `deploy/docker-compose.yml`, `deploy/docker-compose.image.yml`. |
| Alembic migrations                    | Schema bootstrap and upgrades.                                 | `caracal/db/migrations/` + `alembic.ini` at repo root.         |
| Backup / restore tooling              | Operational recovery.                                          | `scripts/backup-postgresql.sh`, `scripts/restore-postgresql.sh`.|
| Cert generation                       | TLS bootstrap for stack.                                       | `scripts/generate-certs.sh`.                                   |
| Redis security bootstrap              | Password / TLS configuration.                                  | `scripts/setup-redis-security.sh`.                             |
| Event-replay recovery                 | Ledger reconciliation.                                         | `scripts/event-replay-recovery.sh`.                            |
| Vault first-run bootstrap             | Auth secret, encryption key, root token.                       | **Missing.** Documented only via env vars, not a command.      |

## 2. Monorepo-only paths the user surface secretly depends on

Each item below is a place where the supposedly "published" surface
silently reaches back into the source checkout. Every one of these is
a packaging gap that must be closed.

### 2.1 Compose file lookup (`caracal up`)

`caracal/runtime/entrypoints.py` defines:

- `COMPOSE_FILE_ENV = "CARACAL_DOCKER_COMPOSE_FILE"`
- `_EMBEDDED_COMPOSE_FILE = resolve_caracal_home(...) / "runtime" / "docker-compose.image.yml"`
- An `_EMBEDDED_COMPOSE_CONTENT` string literal duplicating
  `deploy/docker-compose.image.yml`.
- `--compose-file` CLI flag on every host subcommand.

The compose YAML lives in three places (`deploy/`, the embedded
literal, the `CARACAL_HOME` materialised copy) and is selected via an
ad-hoc precedence chain. The repo path under `deploy/` is reachable
through `CARACAL_DOCKER_COMPOSE_FILE` and `--compose-file`; that path
must be removed from the user contract.

### 2.2 Alembic migrations and `alembic.ini`

- `alembic.ini` lives at the repo root.
- `caracal/cli/db.py:_resolve_alembic_ini_path()` walks up two
  parents from the installed module to find it; this only resolves in
  a source checkout.
- `caracal/db/schema_version.py` defaults `alembic_ini_path` to the
  literal string `"alembic.ini"` — i.e., the current working
  directory at runtime.
- `caracal/db/migrations/env.py` is the migration env file; the
  migrations directory itself ships inside the package, but the
  `alembic.ini` it depends on does not.

### 2.3 Operational shell scripts under `scripts/`

These are documented in `scripts/README.md` and referenced by
operators directly:

- `backup-postgresql.sh`
- `restore-postgresql.sh`
- `generate-certs.sh`
- `setup-redis-security.sh`
- `event-replay-recovery.sh`

They are not packaged into either the Python wheel or the runtime
image's user-facing entry. A user installing only `caracal-core` from
PyPI cannot run any of them.

The remaining scripts (`build-images.sh`, `release.sh`,
`update-version.sh`, `hardcut_*.py`, `partition_authority_ledger.py`,
`verify_dependency_rules.py`) are repo-development only and must
stay out of the user path.

### 2.4 Vault sidecar bootstrap

The compose file references `CARACAL_VAULT_SIDECAR_AUTH_SECRET`,
`CARACAL_VAULT_SIDECAR_ENCRYPTION_KEY`,
`CARACAL_VAULT_TOKEN`, and several other knobs with placeholder
defaults (`caracal-dev-auth-secret`, `dev-local-token`, a hard-coded
hex string). There is no first-run command that generates production
values, performs the seal/unseal flow, or bootstraps the root token.
A real adopter must read source to understand the contract.

### 2.5 SDK reaching back into server modules

`sdk/python-sdk/src/caracal_sdk/_compat.py` imports:

- `from caracal._version import get_version as core_get_version`
- `from caracal.exceptions import AuthorityDeniedError, ConnectionError, SDKConfigurationError`
- `from caracal.logging_config import get_logger as core_get_logger`

The `caracal-sdk` PyPI package therefore silently requires
`caracal-core` to be installed (or fails on import). The SDK is not
in fact standalone. P0.2 requires the SDK to have **zero** imports
from `caracal/`.

### 2.6 Single PyPI package conflates server and user code

The current `pyproject.toml` publishes one package, `caracal-core`,
that bundles:

- the user-facing CLI (`caracal/cli/`),
- the user-facing TUI (`caracal/flow/`),
- the host runtime launcher (`caracal/runtime/entrypoints.py`),
- and **every server-only subsystem**: `caracal/core/`, `caracal/db/`,
  `caracal/identity/`, `caracal/merkle/`, `caracal/enterprise/`,
  `caracal/mcp/`, `caracal/provider/`, `caracal/redis/`,
  `caracal/storage/`, `caracal/monitoring/`, `caracal/deployment/`.

Dependencies follow suit: `psycopg2-binary`, `sqlalchemy`,
`alembic`, `redis`, `cryptography`, `bcrypt`, `prometheus-client`,
`textual`, `prompt_toolkit`, `pyperclip`, `age`, etc., are pulled
into a wheel an end user installs to get a CLI. Most of these have
no business on a control machine that only invokes `caracal up`,
`caracal workspace`, `caracal principal`, etc.

`pyproject.toml` also pins the SDK to a repo path:

```toml
[tool.uv.sources]
caracal-sdk = { path = "sdk/python-sdk", editable = true }
```

This is correct for monorepo development but must not be the path
external consumers traverse.

### 2.7 No published runtime image

The runtime container image referenced by the compose file
(`ghcr.io/garudex-labs/caracal-runtime:latest`) is a default; nothing
in the repo currently publishes that tag, and there is no documented
release procedure that does so. `caracal up` will silently pull
whatever floats at `:latest`.

### 2.8 Two CLI surfaces under one binary

`caracal` resolves to `caracal_entrypoint`, which dispatches host
orchestration subcommands (`up`, `down`, `reset`, `purge`, `logs`,
`cli`, `flow`) outside a container, and a separate full Click CLI
(`caracal.cli.main:cli`) inside the container. The user has to know
which surface they're talking to. The two should converge into a
single `caracal` whose subcommands behave the same locally and
inside the runtime image.

---

## 3. What `pip install caracal-core` actually gets vs. what's needed

Today, on a clean machine with Docker available:

| User goal                                  | `pip install caracal-core` enough? | Gap                                                                 |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------- |
| `caracal --help`                           | Yes                                | None.                                                               |
| `caracal up`                               | No                                 | Needs `deploy/*.yml` from repo, or trusts the embedded literal and a published runtime image tag that does not yet exist. |
| `caracal workspace create`                 | Yes                                | Pulls all server deps into the user wheel unnecessarily.            |
| `caracal migrate` (run migrations)         | No                                 | Needs `alembic.ini` resolvable from cwd or repo layout.             |
| `caracal backup` / `caracal restore`       | No                                 | Subcommands do not exist; user must invoke `scripts/*.sh` from repo. |
| `caracal certs init`                       | No                                 | Subcommand does not exist; `scripts/generate-certs.sh` only.        |
| `caracal redis init`                       | No                                 | Subcommand does not exist; `scripts/setup-redis-security.sh` only.  |
| `caracal events replay`                    | No                                 | Subcommand does not exist; `scripts/event-replay-recovery.sh` only. |
| `caracal vault init`                       | No                                 | No first-run vault bootstrap exists.                                |
| `from caracal_sdk import CaracalClient`    | Conditionally                      | Requires `caracal-core` also installed (SDK→server import leak).    |
| Use Caracal without cloning the monorepo   | No                                 | Compose, alembic.ini, scripts, vault bootstrap all live in repo.    |

---

## 4. Concrete remediation list (input to P0.2 — P0.7)

The work below is what the rest of Phase 0 must deliver. Items map
1:1 to the gaps above.

1. **Split publish targets.** Define three units: `caracal` (PyPI,
   user CLI/TUI/launcher), `caracal-sdk` (PyPI, standalone SDK),
   `caracal-runtime` (container image, server). Retire
   `caracal-core` as a published name. Internal server modules stop
   being PyPI-installable.
2. **Restructure repo into `packages/caracal/` and
   `packages/caracal-server/`.** Keep `sdk/python-sdk/` as the
   `caracal-sdk` source. Drive builds from a uv workspace. Drop the
   `tool.uv.sources` repo-path pin from any user-facing
   `pyproject.toml`.
3. **Strip the SDK→server imports.** `caracal_sdk._compat` must
   inline its own version helper, define its own exception classes
   (or move the existing ones into `caracal_sdk`), and use its own
   logger. After this, `import caracal_sdk` must succeed on a system
   where `caracal/` is not installed.
4. **Embed runtime assets in the `caracal` wheel.** Compose YAML and
   `alembic.ini` ship as package data, loaded via
   `importlib.resources`. `CARACAL_DOCKER_COMPOSE_FILE` and
   `--compose-file` repo-path fallbacks are removed.
5. **Move alembic execution into the runtime image.** `caracal
   migrate` shells into the running runtime container and runs the
   migration command there. `_resolve_alembic_ini_path()` and the
   default `"alembic.ini"` cwd lookup are removed.
6. **Replace shell scripts with first-class subcommands.**
   `caracal backup`, `caracal restore`, `caracal certs`,
   `caracal redis init`, `caracal events replay`. Each runs inside
   the runtime container so dependencies stay in the image.
   `scripts/*.sh` user-facing scripts are deleted.
7. **Provide `caracal vault init`.** A documented first-run command
   that generates the auth secret + encryption key, performs the
   seal/unseal flow against the configured backend, mints the root
   token, and writes the resulting refs into the workspace config.
   The dev-only placeholder values are removed from the published
   compose defaults.
8. **Publish a real runtime image tag.** `caracal-runtime:<version>`
   is built and pushed by the release pipeline; the compose default
   pins to that tag, never `:latest`.
9. **Single `caracal` entry point.** `caracal` with no args opens
   the TUI; `caracal <subcommand>` runs the CLI. Local and
   in-container invocation behave the same. Internal/dev commands
   are removed from `--help` output (or hidden behind `--internal`).
10. **Verify on a clean container.** `pip install caracal
    caracal-sdk`, `caracal up`, `caracal workspace create`,
    `python -c "from caracal_sdk import CaracalClient"` — all pass
    without any path inside this monorepo being referenced.

---

## 5. Out of scope for Phase 0

- Functional changes to enforcement semantics, identity / mandate
  formats, ledger structure, or any wire protocol.
- New features. Phase 0 is purely a packaging and distribution
  refactor.
- Changes to `caracalEnterprise` deployment manifests; that repo is
  versioned and released separately.
