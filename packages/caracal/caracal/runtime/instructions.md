---
description: Apply when adding, editing, or reviewing the caracal runtime package (restricted shell).
applyTo: packages/caracal/caracal/runtime/**
---

## Purpose
Container runtime entry package providing the restricted shell and runtime data bootstrapping.

## Rules
- `restricted_shell.py` is the only file that handles restricted execution contexts; no other files add shell logic.
- Runtime data files (e.g., postgres-init scripts) live in `data/`; no logic in data files.
- This package must not import from `packages/caracal-server`; it is the outer runtime boundary.

## Constraints
- Forbidden: adding business logic to this package; it bootstraps only.
- Forbidden: importing from `caracal.core`, `caracal.cli`, or `caracal.config`.
- Forbidden: dynamic exec or eval in `restricted_shell.py`.
- File names: `restricted_shell.py` only in the runtime root; no new sibling files.

## Error Handling
- Shell violations raise immediately with a descriptive message; no silent fallbacks.
