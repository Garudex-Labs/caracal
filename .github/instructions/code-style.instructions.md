---
description: "Use when writing, editing, or reviewing any code. Enforces naming discipline, comment standards, and variable hygiene across the entire codebase."
applyTo: "**"
---
# Code Style and Naming

- Applies to all source files across the entire codebase.

## Required

- Use short, clear names for variables, functions, files, and folders.
- Use CamelCase as the default naming style.
- Use `_` only when necessary (e.g., Python module files, test fixtures).
- Match the naming pattern already in use in the surrounding code.
- Write comments as if the code is being read for the first time.
- Reuse and correct existing variables; update in place when possible.
- Keep the number of variables minimal and purposeful.
- Match the existing code's level of abstraction and style exactly.

## Forbidden

- Must not use prefixes: `new_`, `fixed_`, `updated_`, `old_`, or similar.
- Must not use `-` in names.
- Must not write comments referencing edits, history, or comparisons (e.g., "changed from", "updated to", "fixed", "previously", "now", "added", "removed").
- Must not reference prompt text, task descriptions, or requirements in comments.
- Must not write comments that restate what the code already expresses.
- Must not duplicate values into new variable names.
- Must not add abstractions, wrappers, or helpers for single-use operations.
- Must not add features, error handling, or logic beyond what was requested.