# core/go/commands

## Scope
- Covers only the Go command catalog mirror under `packages/core/go/commands/`.

## Required
- `catalog.go` must mirror `packages/core/ts/src/commands.ts` exactly: same command names, groups, subcommands, hidden flag.
- Only the control service and any future Go consumer of the canonical surface may import this package.

## Forbidden
- Must not add executor logic; this package only describes shape.
- Must not include flags, defaults, or per-command argument schemas beyond what the TS catalog declares.
