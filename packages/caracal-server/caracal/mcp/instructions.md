---
description: Apply when adding, editing, or reviewing MCP adapter, tool registry, or contract logic.
applyTo: packages/caracal-server/caracal/mcp/**
---

## Purpose
MCP protocol adapter, tool registry, service orchestration, and contract enforcement for MCP tool calls.

## Rules
- `adapter.py` is the protocol boundary; all MCP message handling lives here.
- `registry.py` owns tool registration and lookup; no tool metadata stored elsewhere.
- `service.py` orchestrates tool execution flow between adapter, registry, and core.
- `contract.py` defines and validates MCP tool call contracts; validation runs before execution.
- All tool call inputs must be validated against the registered contract before dispatch.

## Constraints
- Forbidden: business logic in `adapter.py`; it routes only.
- Forbidden: tool registry state mutation outside `registry.py`.
- Forbidden: importing from `cli/` or `flow/`.
- File names: `adapter.py`, `registry.py`, `service.py`, `contract.py` only; add new files only for new top-level concerns.

## Imports
- `adapter.py` imports from `caracal.mcp.service` only.
- `service.py` imports from `caracal.core`, `caracal.mcp.registry`, and `caracal.mcp.contract`.
- Never import from `deployment/` directly.

## Error Handling
- Tool not found raises `ToolNotFoundError`; contract violations raise `ContractViolationError`.
- All errors are returned as structured MCP error responses; never propagate raw exceptions to the protocol layer.

## Security
- All tool call payloads must be validated for type and size before execution.
- Authority checks must run before any tool is dispatched.
