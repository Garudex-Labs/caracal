# MCP Adapter for Caracal Core

This module provides integration between Caracal authority enforcement and the Model Context Protocol (MCP) ecosystem.

## Overview

The MCP Adapter intercepts MCP tool calls and resource reads, enforces authority policies, and records authority events. This enables mandate-based enforcement for MCP-based agents.

## Components

### MCPAdapter

Main adapter class that coordinates authority enforcement for MCP operations.

**Key Methods:**
- `intercept_tool_call()`: Intercepts MCP tool invocations, validates mandates, forwards to MCP server, and records authority events
- `intercept_resource_read()`: Intercepts MCP resource reads, validates mandates, fetches resource, and records authority events

### MCPContext

Context information for MCP requests containing principal ID and metadata.

### MCPResult

Result of an MCP operation with success status, result data, and metadata.

### MCPResource

Represents an MCP resource with URI, content, MIME type, and size.

## Usage Example

```python
from caracal.mcp import MCPAdapter, MCPContext
from caracal.core.authority import AuthorityEnforcer
from caracal.core.ledger import LedgerWriter

# Initialize components
authority_enforcer = AuthorityEnforcer(policy_store)
ledger_writer = LedgerWriter(db_connection)

# Create MCP adapter
adapter = MCPAdapter(
    authority_enforcer=authority_enforcer,
    ledger_writer=ledger_writer
)

# Intercept tool call
context = MCPContext(
    principal_id="principal-uuid",
    metadata={"source": "mcp-client"}
)

result = await adapter.intercept_tool_call(
    tool_name="llm_completion",
    tool_args={
        "prompt": "Hello, world!",
        "max_tokens": 100,
        "model": "gpt-4"
    },
    mcp_context=context
)

if result.success:
    print(f"Tool result: {result.result}")
else:
    print(f"Error: {result.error}")
```

## Resource Registration

Register MCP resources in the resource registry for use in policies:

```
api:mcp/tool.default
api:mcp/resource.default
api:mcp/llm.gpt-4
api:mcp/llm.claude-3
api:mcp/file.read
```

## Architecture

```
+------------------+
|   MCP Client     |
+--------+---------+
         |
         v
+------------------+
|   MCPAdapter     |<------+
+--------+---------+       |
         |                 |
         +--------+--------+--> AuthorityEnforcer (mandate check)
         |                 |
         +--------+--------+--> MCP Server (tool execution)
         |                 |
         +--------+--------+--> LedgerWriter (record event)
```

## Error Handling

The adapter implements fail-closed semantics:
- Missing mandate raises `AuthorityDeniedError`
- Missing principal ID raises `CaracalError`
- Other errors return `MCPResult` with `success=False` and error message
- Authority events are recorded for both allowed and denied operations

## Logging

The adapter logs:
- Tool call interceptions (DEBUG)
- Resource read interceptions (DEBUG)
- Authority check results (INFO)
- Ledger events (INFO)
- Errors (ERROR)

```python
import logging
logging.getLogger("caracal.mcp").setLevel(logging.DEBUG)
```

## See Also

- [MCP Decorator Mode](./mcpDecorators) -- SDK plugin mode
- [SDK Client](./sdkClient) -- Authority enforcement SDK
