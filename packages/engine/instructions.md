# packages/engine

## Scope
- Covers the `@caracalai/engine` TypeScript package under `packages/engine/`.

## Architecture Design
- Engine owns non-HTTP execution used by the top-level shell and Console: stack lifecycle, runtime asset provisioning, process execution for `caracal run`, credential reads, control invocation, OAuth step-up, token scrubbing, and crash-safe helpers.
- `@caracalai/admin` owns admin HTTP calls.
- `agentLaunch.ts`, `agentBroker.ts`, and `agentProfile.ts` own governed agent execution; agent-specific launch, hook, and flag handling lives only in `agentAdapters.ts`.
- `src/embedded.ts` is generated from runtime assets by `scripts/build-embedded.mjs`.

## Required
- Must expose pure async functions that accept typed options and return unformatted results.
- Must keep streaming APIs callback-based and disposable.
- Must generate embedded runtime assets before build and typecheck through existing scripts.
- Must scrub token-bearing strings before exposing them to callers.
- Must keep Console-specific formatting outside this package.
- Must answer every agent tool hook with an explicit decision and deny on any error or late decision.

## Forbidden
- Must not parse argv, print to stdout/stderr, manipulate Console state, or call `process.exit`.
- Must not import from `apps/`.
- Must not read disk or environment state except through explicit caller-provided options.
- Must not embed credentials.

## Validation
- Validate with `pnpm --dir packages/engine build` and `pnpm --dir packages/engine typecheck`.
