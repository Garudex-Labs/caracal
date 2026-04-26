---
description: "Use when refactoring, cleaning up, or reviewing code for legacy patterns, deprecated structures, fallback paths, backward compatibility layers, or duplicate logic."
applyTo: "**"
---
# Legacy Code Elimination

## Core Rule

There is one current implementation. Remove everything else.

## What to Remove

- Fallback paths and compatibility shims for older behavior
- Deprecated functions, classes, or modules kept "for safety"
- Duplicate logic serving the same purpose through alternate flows
- Feature flags or branches gating old vs. new behavior
- Dead code, commented-out blocks, and unused abstractions
- Version-conditional branches (`if version < X`) that no longer apply

## How to Handle Affected Areas

- Rewrite the area cleanly around the current design — not as a patch on top of old code.
- When legacy interference makes a section messy, rewrite it fully rather than incrementally fixing it.
- Each feature must have a single, clear execution path.

## What Not to Do

- Do not preserve old logic "just in case."
- Do not layer new implementations on top of existing ones.
- Do not leave stubs, wrappers, or adapters whose only purpose is bridging old and new.
- Do not add migration helpers unless a migration is explicitly required now.
