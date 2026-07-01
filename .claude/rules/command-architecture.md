---
description: "Use when changing Caracal commands, package scripts, the web console, runtime CLI launchers, command catalogs, completions, or command documentation. Enforces the runtime-script versus product-management boundary."
applyTo: "{package.json,apps/runtime/**,apps/web/**,packages/engine/src/commands.ts,packages/engine/src/dispatch.ts,docs/**,README.md,CONTRIBUTING.md}"
---

# Command Architecture

- Top-level `caracal` runtime CLI commands must only manage local runtime lifecycle and setup: start, stop, status, purge, and optional interface launchers such as `web`.
- Top-level package scripts must not provide product-management aliases for zones, policies, grants, Control credentials, audit, agents, delegation, or other admin workflows.
- Product management must live only in the web console and its shared engine/admin helpers, with the Control API or Admin SDK for automation.
- The web console must expose product capabilities with consistent names, lifecycle behavior, terminology, and engine integration.
- The web console launcher (`caracal web`) must remain optional; top-level help and dispatch must hide it when its workspace packages are unavailable.
- If the web console is unavailable, the top-level runtime CLI must still expose lifecycle commands.
- Control API management is a web-console product-management surface; it must not be exposed as a top-level runtime command or recursively through remote Control dispatch.
- Runtime lifecycle code must not require admin tokens, zone selection, product credentials, or Control credentials.
- Command documentation must show runtime lifecycle examples through `caracal` and product-management workflows through the web console (`caracal web`), the Control API, or the Admin SDK.
