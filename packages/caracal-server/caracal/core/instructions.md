---
description: Apply when adding, editing, or reviewing core business logic modules.
applyTo: packages/caracal-server/caracal/core/**
---

## Purpose
Core business logic: authority evaluation, delegation, cryptography, vault, session management, and mandate enforcement.

## Rules
- Each file owns exactly one domain concept; names are singular nouns (e.g., `mandate.py`, `vault.py`).
- All public functions are pure or explicitly documented as stateful.
- Vault, crypto, and signing operations must use the abstractions in `vault.py` and `crypto.py`; no raw key material handling elsewhere.
- Rate limiting and circuit breaker logic live in `rate_limiter.py` and `circuit_breaker.py` exclusively.
- Delegation graph traversal lives in `delegation_graph.py` only.

## Constraints
- Forbidden: DB session creation inside core modules; core receives sessions as parameters.
- Forbidden: HTTP calls outside `vault.py` and `signing_service.py`.
- Forbidden: importing from `cli/`, `flow/`, or `runtime/`.
- File names: `snake_case.py`, one concept per file.
- Function names: `snake_case` verb phrases.

## Imports
- Import from `caracal.exceptions`, `caracal.config.settings`, and sibling core modules only.
- Avoid circular imports; core modules must not import from `deployment/`, `identity/`, or `provider/`.

## Error Handling
- Raise typed exceptions from `caracal.exceptions` only.
- `VaultConfigurationError` for vault config failures; `DelegationError` for delegation failures.
- Never catch and suppress errors inside core; propagate to the caller boundary.

## Security
- All signing operations must validate algorithm against the hardcut allowlist before execution.
- Principal key material must never be logged, printed, or serialized as plaintext.
- Input validation must occur at every public function boundary.
