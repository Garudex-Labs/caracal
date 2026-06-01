---
description: "Use when changing Caracal commands, package scripts, Consoles, runtime CLI launchers, command catalogs, completions, or command documentation. Enforces the runtime-script versus product-management boundary."
applyTo: "{package.json,apps/runtime/**,apps/console/**,packages/engine/src/commands.ts,packages/engine/src/dispatch.ts,docs/**,README.md,.github/CONTRIBUTING.md}"
---

# Command Architecture

- Top-level `caracal` runtime CLI commands must only manage local runtime lifecycle and setup: start, stop, status, purge, and optional interface launchers.
- Top-level package scripts must not provide product-management aliases for zones, policies, grants, Control credentials, audit, agents, delegation, or other admin workflows.
- Product management commands must live only in the Console and its shared engine/admin helpers.
- The Console must expose product capabilities with consistent names, lifecycle behavior, terminology, and engine integration.
- The Console launcher must remain optional; top-level help and dispatch must hide it when its binary or workspace shim is unavailable.
- If the Console is unavailable, the top-level runtime CLI must still expose lifecycle commands.
- Control API management is a Console product-management surface; it must not be exposed as a top-level runtime command or recursively through remote Control dispatch.
- Runtime lifecycle code must not require admin tokens, zone selection, product credentials, or Control credentials.
- Command documentation must show runtime lifecycle examples through `caracal` and product-management examples through `caracal console` or `caracal-console`.
