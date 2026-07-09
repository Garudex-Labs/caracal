# .githooks

## Scope
- Covers the version-controlled git hooks activated through `core.hooksPath` by the root `prepare` script.

## Required
- Hooks must be POSIX `sh` scripts with the executable bit set.
- Hooks must delegate all logic to scripts under `scripts/`.
- Hooks must stay fast and scoped to the files involved in the git operation.

## Forbidden
- Must not embed formatting, lint, or test logic directly in a hook.
- Must not add hooks that require network access or product credentials.
