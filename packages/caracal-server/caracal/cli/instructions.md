---
description: Apply when adding, editing, or reviewing CLI command handlers.
applyTo: packages/caracal-server/caracal/cli/**
---

## Purpose
CLI command handlers for all `caracal` subcommands. Each file owns one command group.

## Rules
- One file per command group; file name matches the group name exactly.
- All handlers are thin wrappers: parse args, call core or service, return output.
- No business logic inside handlers; delegate entirely to `core/` or `deployment/`.
- Errors surface via `caracal.exceptions`; never raise raw Python exceptions.
- Output formatting uses `rich` only; no `print()` calls outside of `main.py`.

## Constraints
- Forbidden: DB queries, vault calls, or crypto operations directly in handlers.
- Forbidden: new command groups without a corresponding `core/` or `deployment/` module.
- Forbidden: interactive prompts outside `flow/`.
- File names: `lowercase_noun.py` (e.g., `authority.py`, `ledger.py`).
- Function names: `snake_case` verb phrases matching the subcommand.

## Imports
- Import from `caracal.core`, `caracal.deployment`, `caracal.config.settings` only.
- Never import cross-module siblings (e.g., `cli.authority` must not import `cli.ledger`).

## Error Handling
- Catch `caracal.exceptions.CaracalError` subclasses at the handler boundary.
- Exit with non-zero code on all operational errors; use `sys.exit(1)`.
