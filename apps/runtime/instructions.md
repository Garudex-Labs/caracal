# apps/runtime

## Scope
- Covers the `@caracalai/runtime` runtime shell under `apps/runtime/`.

## Architecture Design
- `bin/` owns executable entrypoints.
- `src/commands/` owns argument parsing, command dispatch, output formatting, and exit-code mapping.
- `@caracalai/engine` owns stack, runtime, process behavior, and the execution helpers used by top-level `caracal run`.

## Required
- Must run on Node 24+ and keep release binaries produced by the existing Bun compile scripts.
- Must keep runtime handlers thin: parse flags, call package APIs, format output, and set exit codes.
- Must resolve stack mode through stamped version constants with explicit environment override only.
- Must keep `caracal.toml` resolution consistent with Console and engine behavior.
- Must scrub tokens, credentials, and sensitive environment values from errors and streamed output.

## Forbidden
- Must not write credentials, access tokens, refresh tokens, or client secrets to disk.
- Must not depend on a Bun runtime after compilation.
- Must not spawn user input through a shell.

## Validation
- Validate with `pnpm --dir apps/runtime typecheck` and `pnpm --dir apps/runtime test` when runtime code changes.
