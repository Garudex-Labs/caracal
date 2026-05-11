# Scripts

## Scope
- Only repo-level automation scripts that wrap pnpm, git, and CI workflows.

## Required
- Every script must be executable and start with `#!/usr/bin/env bash` (or matching interpreter).
- Every script must include the standard file header.
- Scripts must be idempotent and fail fast (`set -euo pipefail`).
- Scripts must run from the repo root regardless of caller cwd.

## Forbidden
- Must not embed secrets or tokens.
- Must not duplicate logic that already exists as a `pnpm` workspace script.
- Must not call services other than git, pnpm, node, and standard POSIX tools.
