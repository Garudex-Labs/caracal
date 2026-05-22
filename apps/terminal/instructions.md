# apps/tui

## Scope
- Covers the `@caracalai/tui` terminal UI under `apps/tui/`.

## Architecture Design
- `src/screen.ts`, `src/keys.ts`, and `src/ansi.ts` own terminal primitives.
- `src/views/` owns menu, list, detail, form, stream, audit, and action views.
- `@caracalai/admin` owns HTTP access; `@caracalai/engine` owns command bodies and process behavior.

## Required
- Must run on Node 24+ and keep release binaries produced by the existing Bun compile scripts.
- Must restore terminal state on normal exit, fatal error, and interrupt.
- Must keep view timers, streams, and child processes disposable when a view leaves the stack.
- Must mask credential and token fields by default.
- Must keep CLI-compatible config resolution for API URL, coordinator URL, zone ID, and `caracal.toml`.
- Must accept input only from a controlling terminal: refuse to start when stdin or stdout is not a TTY, when `TERM` is unset or `dumb`, when `CI=true`, or when launched with an IPC channel.

## Forbidden
- Must not use React, Ink, blessed, or another heavyweight terminal UI framework.
- Must not write secrets, tokens, or refresh tokens to disk.
- Must not pass user input to a shell.
- Must not render unsanitized JWTs, Caracal tokens, or credentials in exceptions.
- Must not expose any scripted-input, replay, workload execution, or automation entry point: workload execution belongs to top-level `caracal run`, and remote automation belongs to the Control API or SDK.

## Validation
- Validate with `pnpm --dir apps/tui typecheck` and `pnpm --dir apps/tui test` when TUI code changes.
