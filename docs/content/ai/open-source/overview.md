---
id: ai-open-source-overview
title: Open Source Overview
slug: /ai/open-source/overview
sidebar_label: Overview
canonical_human: /open-source/overview
applies_to: [oss]
edition: oss
audience: ai
page_type: concept
version: 1.0
status: authored
last_verified: 2026-04-27
source_files:
  - README.md
  - ABBREVIATIONS.md
  - packages/caracal/pyproject.toml
  - packages/caracal-server/pyproject.toml
  - packages/caracal/caracal/runtime/entrypoints.py
  - packages/caracal/caracal/runtime/hardcut_preflight.py
---

# Open Source Overview (AI)

> Canonical human page: [/open-source/overview](/open-source/overview)

## Definition

Caracal Open Source is the self-managed runtime and host orchestrator for pre-execution authority enforcement.

## Inputs

| name | type | required | source | notes |
| --- | --- | --- | --- | --- |
| CCL_* runtime configuration | environment variables | yes | ABBREVIATIONS.md, runtime modules | Open Source prefix namespace |
| Runtime service dependencies | services | yes | runtime entrypoints | up path starts postgres, redis, mcp |
| Managed secret backend | configuration | yes in hard-cut runtime paths | hardcut_preflight.py | backend must be vault |

## Outputs

| name | type | notes |
| --- | --- | --- |
| Host orchestration command surface | CLI commands | `caracal` entrypoint with up/down/reset/purge/logs/cli/flow/migrate |
| Runtime authority modules | Python package modules | installed in runtime container image (`caracal-server`) |
| Enforced preflight checks | runtime validation | rejects forbidden hard-cut configurations |

## Constraints

- Hard-cut runtime paths reject SQLite and require PostgreSQL.
- Hard-cut runtime paths require `CCL_PRINCIPAL_KEY_BACKEND=vault`.
- Hard-cut runtime paths require vault environment keys including URL, token, signing key reference, and session public key reference.
- Hard-cut runtime paths reject local vault modes (`local`, `dev`, `development`).
- Prefix boundary is strict: `CCL_` for Open Source, `CCLE_` for Enterprise.
- Scope is self-managed deployment from repository/runtime artifacts; no hosted service contract is defined here.

## Steps

1. Install and invoke the host orchestrator from `caracal-core` (`caracal` script).
2. Start runtime services with `caracal up`.
3. Use `caracal cli` or `caracal flow` for runtime interaction.
4. Ensure hard-cut preflight constraints are satisfied before protected runtime operations.
5. Operate with `CCL_*` variables for Open Source paths; keep Enterprise-only `CCLE_*` settings separate.

## Usage rules

- Do: treat Open Source as the host orchestrator plus runtime server modules.
- Do: model runtime behavior using `packages/caracal/caracal/runtime/` and `packages/caracal-server/caracal/`.
- Do: enforce hard-cut preflight constraints as mandatory runtime requirements.
- Do not: mix Enterprise-only environment namespace into Open Source configuration assumptions.
- Do not: rely on SQLite or local vault mode in hard-cut runtime paths.

## Errors

| code | meaning | remediation |
| --- | --- | --- |
| HC_SQLITE_FORBIDDEN | SQLite detected in hard-cut runtime path | switch to PostgreSQL connection settings |
| HC_SECRET_BACKEND_INVALID | non-vault secret backend in hard-cut runtime path | set `CCL_PRINCIPAL_KEY_BACKEND=vault` |
| HC_VAULT_ENV_MISSING | required vault env key missing | provide required `CCL_VAULT_*` values |
| HC_VAULT_MODE_FORBIDDEN | `CCL_VAULT_MODE` set to local/dev/development | use managed runtime vault mode |

## Examples

```bash
caracal up
caracal cli
caracal flow
```

```env
CCL_PRINCIPAL_KEY_BACKEND=vault
CCL_VAULT_URL=https://vault.example
CCL_VAULT_TOKEN=...
CCL_VAULT_SIGNING_KEY_REF=keys/mandate-signing
CCL_VAULT_SESSION_PUBLIC_KEY_REF=keys/session-public
```

## See also

- [/ai/open-source/end-users/concepts/authority-enforcement-model](/ai/open-source/end-users/concepts/authority-enforcement-model)
- [/ai/open-source/end-users/concepts/policy](/ai/open-source/end-users/concepts/policy)
- [/ai/open-source/end-users/concepts/mandate](/ai/open-source/end-users/concepts/mandate)
- [/open-source/end-users/concepts/authority-enforcement-model](/open-source/end-users/concepts/authority-enforcement-model)
- [/open-source/end-users/concepts/policy](/open-source/end-users/concepts/policy)
- [/open-source/sdk/reference/tool-id-grammar](/open-source/sdk/reference/tool-id-grammar)
