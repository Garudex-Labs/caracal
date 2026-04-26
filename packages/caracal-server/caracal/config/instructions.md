---
description: Apply when adding, editing, or reviewing configuration loading or validation logic.
applyTo: packages/caracal-server/caracal/config/**
---

## Purpose
Configuration loading, validation, and encryption for the Caracal server.

## Rules
- All config state lives in `settings.py`; `encryption.py` handles field-level encryption only.
- `load_config()` is the single entry point for reading YAML config files.
- Every new config field must have a corresponding validation clause in `_validate_config()`.
- Encrypted fields use `EncryptedField`; never store secrets as plaintext in config objects.
- Config objects are frozen dataclasses; mutation after construction is forbidden.

## Constraints
- Forbidden: reading environment variables directly outside `settings.py`.
- Forbidden: adding new config files; extend `settings.py` and `encryption.py` only.
- File names: `settings.py` and `encryption.py` are the only permitted files.
- Class names: `PascalCase` suffixed with `Config` (e.g., `MerkleConfig`).

## Imports
- Import from `caracal.exceptions` for `InvalidConfigurationError`.
- No imports from `caracal.core` or `caracal.cli`.

## Error Handling
- Raise `InvalidConfigurationError` on all invalid or missing required config values.
- Never swallow validation errors; always propagate with the config path in the message.
