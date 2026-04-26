---
description: Apply when adding, editing, or reviewing build, release, or maintenance scripts.
applyTo: scripts/**
---

## Purpose
Build automation, release tooling, dependency cycle detection, and partition authority scripts.

## Rules
- Each script has a single, explicit purpose; its file name must match that purpose exactly.
- All scripts must be idempotent; running twice must produce the same result.
- Python scripts target the project's Python version; no version-conditional branches.
- Shell scripts must begin with `set -euo pipefail`.
- `placeholder-packages/` contains PyPI name-reservation stubs only; no logic goes inside them.

## Constraints
- Forbidden: scripts that modify production data or infrastructure directly.
- Forbidden: hardcoded credentials or tokens in any script.
- Forbidden: business logic; scripts orchestrate tools, not implement features.
- File names: `snake_case.py` for Python; `kebab-case.sh` for shell.

## Error Handling
- Scripts must exit non-zero on any failure; never swallow errors with `|| true`.
- Error output must identify the failing step by name.
