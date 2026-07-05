# .githooks

## Scope
- Covers the versioned git hooks installed via `core.hooksPath`.

## Required
- Hooks must be POSIX sh scripts, executable, and runnable from the repository root.
- Hooks must delegate to existing repository scripts instead of embedding logic.
- `scripts/setupHooks.mjs` must remain the only installer for this directory.

## Forbidden
- Must not add hooks that mutate files or amend commits.
- Must not bypass or weaken the style gate.
