---
description: "Use when changing Caracal commands, package scripts, terminal management surfaces, shell launchers, command catalogs, completions, or command documentation. Enforces the runtime-script versus product-management boundary."
applyTo: "{package.json,apps/runtime/**,apps/terminal/**,packages/engine/src/commands.ts,packages/engine/src/dispatch.ts,docs/**,README.md,CONTRIBUTING.md}"
---

# Command Architecture

- Top-level `caracal` shell commands must only manage local runtime lifecycle and setup: start, stop, status, purge, and optional interface launchers.
- Top-level package scripts must not provide product-management aliases for zones, policies, grants, Control credentials, audit, agents, delegation, or other admin workflows.
- Product management commands must live only in the terminal management surface and its shared engine/admin helpers.
- The terminal management interface must expose product capabilities with consistent names, lifecycle behavior, terminology, and engine integration.
- The terminal launcher must remain optional; top-level help and dispatch must hide it when its binary or workspace shim is unavailable.
- If the terminal interface is unavailable, the top-level shell must still expose lifecycle commands.
- Control API management is a terminal product-management surface; it must not be exposed as a top-level runtime command or recursively through remote Control dispatch.
- Runtime lifecycle code must not require admin tokens, zone selection, product credentials, or Control credentials.
- Command documentation must show runtime lifecycle examples through `caracal` and product-management examples through `caracal terminal` or `caracal-terminal`.
