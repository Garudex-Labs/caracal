# apps/cli

## Scope
- Covers the `@caracalai/cli` command-line app under `apps/cli/`.

## Architecture Design
- `bin/` owns executable entrypoints.
- `src/commands/` owns argument parsing, command dispatch, output formatting, and exit-code mapping.
- `@caracalai/engine` owns stack, runtime, credential, control, process behavior, and the execution helpers used by top-level `caracal run`.
- `@caracalai/admin` owns admin and coordinator HTTP calls.

## Required
- Must run on Node 24+ and keep release binaries produced by the existing Bun compile scripts.
- Must keep CLI handlers thin: parse flags, call package APIs, format output, and set exit codes.
- Must resolve stack mode through stamped version constants with explicit environment override only.
- Must keep `caracal.toml` resolution consistent with TUI and engine behavior.
- Must require the correct admin, coordinator, or control token before privileged commands.
- Must scrub tokens, credentials, and sensitive environment values from errors and streamed output.

## Forbidden
- Must not write credentials, access tokens, refresh tokens, or client secrets to disk.
- Must not call admin or coordinator endpoints with ad hoc `fetch` from command modules.
- Must not depend on a Bun runtime after compilation.
- Must not spawn user input through a shell.

## Validation
- Validate with `pnpm --dir apps/cli typecheck` and `pnpm --dir apps/cli test` when CLI code changes.
