---
description: Apply when adding, editing, or reviewing the Python SDK.
applyTo: sdk/python-sdk/**
---

## Purpose
Python client SDK for interacting with the Caracal runtime API, AIS, and enterprise gateway.

## Rules
- `client.py` is the top-level SDK entry point; all user-facing API calls go through it.
- `adapters/` contains protocol-specific transport adapters; one file per transport.
- `enterprise/` contains enterprise-only client extensions; gate all enterprise paths.
- `ais.py` handles AIS token acquisition only; no AIS logic in other files.
- `hooks.py` defines request/response lifecycle hooks; no business logic inside hooks.
- `extensions.py` holds optional SDK feature extensions; all are opt-in.

## Constraints
- Forbidden: hard-coding Caracal server URLs; all endpoints must be configurable.
- Forbidden: storing credentials in module-level state.
- Forbidden: importing from the server packages (`packages/caracal-server`).
- File names: `snake_case.py`; class names: `PascalCase`.

## Imports
- Import from `httpx`, `caracal_sdk.client`, and standard library only.
- Enterprise modules import from `caracal_sdk.enterprise` only.

## Error Handling
- All API errors raise `CaracalSDKError` subclasses; never raise raw `httpx` exceptions to callers.
- Timeouts and connection errors must include the attempted endpoint in the error message.

## Security
- Credentials must be passed per-request, not stored as instance state.
- All server-returned data must be validated against the expected schema before use.
