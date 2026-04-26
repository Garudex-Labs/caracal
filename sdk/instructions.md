---
description: Apply when adding, editing, or reviewing SDK packages or shared SDK infrastructure.
applyTo: sdk/**
---

## Purpose
Client SDKs for Caracal. Contains the Python SDK (`python-sdk/`) and Node.js SDK (`node-sdk/`) only.

## Rules
- Each SDK is independent; SDKs must not import from each other.
- Versioning is independent per SDK; each SDK carries its own `VERSION` file.
- New SDK directories must each contain an `instructions.md` before adding any source files.
- Shared types or schemas must be maintained separately in each SDK; no shared source.

## Constraints
- Forbidden: adding a third SDK directory without a corresponding `instructions.md`.
- Forbidden: server-side logic or database access in any SDK.
- Directory names: `<language>-sdk` format (e.g., `python-sdk`, `node-sdk`).

## Testing
- SDK tests live in `<sdk>/tests/` only.
- Use shared mock servers, not live Caracal instances, for SDK tests.
