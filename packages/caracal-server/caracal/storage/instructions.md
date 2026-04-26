---
description: Apply when adding, editing, or reviewing storage layout, key audit, or storage migration logic.
applyTo: packages/caracal-server/caracal/storage/**
---

## Purpose
Host-local storage layout, key audit records, and storage migration utilities.

## Rules
- `layout.py` defines all storage path conventions; file paths must always be derived from it.
- `key_audit.py` records key material audit events; no other file writes audit records.
- `migration.py` handles storage schema migration; no migration logic in other files.
- All file paths must be resolved from `CCL_HOME`; no hardcoded absolute paths.

## Constraints
- Forbidden: writing secret material to storage outside `key_audit.py` audit entries.
- Forbidden: importing from `cli/`, `flow/`, or `runtime/`.
- Forbidden: creating new storage subdirectories outside `layout.py`.
- File names: `layout.py`, `key_audit.py`, `migration.py` only.

## Imports
- Import from `caracal.config.settings`, `caracal.exceptions`, and `pathlib` only.

## Error Handling
- Missing required directories raise `StorageLayoutError`.
- Audit write failures must raise, not silently fail; audit integrity is required.

## Security
- Audit log files must be append-only; never truncate or overwrite existing audit entries.
- File permissions must be set to `0o600` for all secret-adjacent files.
