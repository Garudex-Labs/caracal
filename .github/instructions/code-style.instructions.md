---
description: "Use when writing, editing, or reviewing any code. Enforces naming discipline, comment standards, and variable hygiene across the entire codebase."
applyTo: "**"
---
# Code Style and Naming

## Naming

- Prefer short, clear names for variables, functions, files, and folders.
- Use CamelCase as the default. Avoid `-`. Use `_` only when necessary (e.g., Python module files, test fixtures).
- Never use prefixes like `new_`, `fixed_`, `updated_`, `old_`, or similar when editing code.
- Keep names consistent with the surrounding codebase style—match the pattern already in use.

## Comments

- Write comments as if the code is being read for the first time—no references to edits, history, or comparisons.
- Never write: "changed from", "updated to", "fixed", "previously", "now", "added", "removed".
- Never reference prompt text, task descriptions, or requirements in comments.
- Omit comments that restate what the code already expresses clearly.

## Variable Discipline

- Reuse and correct existing variables rather than introducing new ones.
- Do not duplicate values into new names when the original can be updated in place.
- Keep the number of variables minimal and purposeful.

## Implementation

- Do not add abstractions, wrappers, or helpers for single-use operations.
- Do not add features, error handling, or logic beyond what was requested.
- Match the existing code's level of abstraction and style exactly.