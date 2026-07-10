# packages/engine/src

## Scope

- Covers source modules for `@caracalai/engine` under `packages/engine/src/`.

## Architecture Design

- Each module owns one execution concern or command noun.
- `index.ts` re-exports the package surface; module-internal helpers stay private.

## Required

- Must keep verb bodies independent of runtime flag parsing and presentation rendering.
- Must accept typed options objects instead of positional command-line state.
- Must keep generated `embedded.ts` produced by the build script.
- Must preserve token scrubbing on any user-visible string path.

## Forbidden

- Must not import from `apps/runtime`.
- Must not write to stdout, stderr, or terminal rendering APIs.
- Must not call `process.exit`.

## Validation

- Validate with `pnpm --dir packages/engine build` after source changes.
