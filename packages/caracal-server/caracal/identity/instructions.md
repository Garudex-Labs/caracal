---
description: Apply when adding, editing, or reviewing identity attestation, registration, or TTL logic.
applyTo: packages/caracal-server/caracal/identity/**
---

## Purpose
AIS server, attestation nonce management, principal registration, and principal TTL enforcement.

## Rules
- `ais_server.py` implements the AIS token issuance endpoint exclusively.
- `attestation_nonce.py` manages nonce generation and validation; no other file handles nonces.
- `service.py` is the identity service layer called by the runtime API.
- `principal_ttl.py` enforces TTL policies for registered principals; no TTL logic elsewhere.
- All nonce values must be cryptographically random; use `secrets.token_urlsafe()`.

## Constraints
- Forbidden: storing nonces after validation; consume and discard immediately.
- Forbidden: identity logic in `core/` or `cli/`.
- Forbidden: accepting caller-supplied algorithm strings without validating against the allowlist.
- File names: `snake_case.py` matching the single concern.

## Imports
- Import from `caracal.core`, `caracal.db`, and `caracal.exceptions`.
- Never import from `deployment/` or `flow/`.

## Security
- All token claims must be validated for type, range, and signing algorithm before issuance.
- Nonce reuse must be rejected; validate uniqueness before accepting attestation.
- Subject binding must be verified on every AIS issuance request.
