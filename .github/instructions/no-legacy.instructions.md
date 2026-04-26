---
description: "Use when refactoring, cleaning up, or reviewing code for legacy patterns, deprecated structures, fallback paths, backward compatibility layers, or duplicate logic."
applyTo: "**"
---
# Legacy Code Elimination

- Applies to all source files. There is one current implementation; remove everything else.

## Required

- Remove fallback paths and compatibility shims for older behavior.
- Remove deprecated functions, classes, or modules kept for safety.
- Remove duplicate logic serving the same purpose through alternate flows.
- Remove feature flags or branches gating old vs. new behavior.
- Remove dead code, commented-out blocks, and unused abstractions.
- Remove version-conditional branches that no longer apply.
- Rewrite affected areas cleanly around the current design.
- Each feature must have exactly one clear execution path.

## Forbidden

- Must not preserve old logic "just in case".
- Must not layer new implementations on top of existing ones.
- Must not leave stubs, wrappers, or adapters whose only purpose is bridging old and new.
- Must not add migration helpers unless a migration is explicitly required now.
- Must not patch on top of legacy code — rewrite it fully.
