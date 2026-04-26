---
description: Apply when adding, editing, or reviewing provider catalog, credential store, or workspace logic.
applyTo: packages/caracal-server/caracal/provider/**
---

## Purpose
Provider catalog resolution, credential storage, and workspace configuration for tool providers.

## Rules
- `catalog.py` resolves provider definitions from config; no dynamic provider discovery.
- `credential_store.py` manages provider credential lifecycle; all credential reads go through it.
- `workspace.py` maps workspace IDs to provider configurations; no workspace state elsewhere.
- `definitions.py` holds provider type definitions and schemas; no logic, only types.
- Credentials must never be logged or included in error messages.

## Constraints
- Forbidden: storing credentials in memory beyond the request scope.
- Forbidden: provider logic in `core/` or `cli/`.
- Forbidden: importing from `deployment/` or `flow/`.
- File names: `catalog.py`, `credential_store.py`, `workspace.py`, `definitions.py` only.

## Imports
- Import from `caracal.core`, `caracal.config.settings`, and `caracal.exceptions`.

## Security
- All credential values must be masked in logs; use `***` placeholders.
- Provider URLs must be validated against an allowlist before use.
- Credential decryption must use keys from `caracal.core.vault`; no plaintext secrets in config.
