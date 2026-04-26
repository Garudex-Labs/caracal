---
description: Apply when adding, editing, or reviewing runtime API entrypoints, preflight, or gate checks.
applyTo: packages/caracal-server/caracal/runtime/**
---

## Purpose
FastAPI runtime entrypoints, hard-cut preflight enforcement, and runtime gate checks for the Caracal API.

## Rules
- All FastAPI route handlers live in `entrypoints.py`; no route definitions in other files.
- Hard-cut preflight checks live in `hardcut_preflight.py`; no preflight logic elsewhere.
- Gate checks (env var validation, mode checks) live in `gates.py` only.
- `restricted_shell.py` (in `packages/caracal`) provides the shell execution boundary; never bypass it.
- Preflight must run before any route handler accepts requests.

## Constraints
- Forbidden: business logic in route handlers; delegate to `core/` and `identity/`.
- Forbidden: skipping preflight in any runtime mode including tests without explicit mock.
- Forbidden: importing from `cli/` or `flow/` in runtime modules.
- All new env vars must be declared in `gates.py` with explicit validation.

## Imports
- Route handlers import from `caracal.core`, `caracal.identity`, `caracal.mcp`, `caracal.deployment`.
- `hardcut_preflight.py` imports from `caracal.exceptions` and `os` only.

## Error Handling
- Preflight failures raise `HardCutPreflightError`; never catch and continue.
- Route handler errors return structured HTTP error responses; never 500 on known error conditions.

## Security
- All route inputs must be validated for type and range before processing.
- Authentication must be verified on every protected endpoint; no bypass paths.
- Symmetric session signing algorithms must be rejected at preflight.
