# MCP Adapter for Caracal Core

This module provides integration between Caracal authority enforcement and the Model Context Protocol (MCP) ecosystem.

## Overview

The MCP Adapter intercepts MCP tool calls and resource reads, validates cryptographically signed **execution mandates**, and ensures that all agentic actions are authorized according to governing **authority policies**.

## Components

### MCPAdapter

Main adapter class that coordinates authority enforcement for MCP operations.

**Key Methods:**
- `intercept_tool_call()`: Intercepts MCP tool invocations, validates mandates, forwards to MCP server, and logs to the authority ledger.
- `intercept_resource_read()`: Intercepts MCP resource reads, validates mandates, fetches resource, and logs to the authority ledger.

**Authority Enforcement Flow:**
1. Intercept MCP request.
2. Extract mandate and principal identity from MCP context.
3. Validate mandate against requested resource and action.
4. Forward to MCP server if authorized; deny if unauthorized (fail-closed).
5. Log the decision to the immutable Authority Ledger.

### MCPContext

Context information for MCP requests containing principal identity, mandate, and metadata.

### MCPResult

Result of an MCP operation with success status, result data, and authority decision metadata.

### MCPResource

Represents an MCP resource with URI, content, MIME type, and size.

## Usage Example

```python
from caracal.mcp import MCPAdapter, MCPContext
from caracal.core.authority import MandateEvaluator
from caracal.db import DatabaseConnectionManager

# Initialize components
db_manager = DatabaseConnectionManager(db_config)
mandate_evaluator = MandateEvaluator(db_manager)

# Create MCP adapter
adapter = MCPAdapter(
    mandate_evaluator=mandate_evaluator
)

# Intercept tool call with a mandate
context = MCPContext(
    principal_id="agent-uuid",
    mandate_id="mandate-uuid",
    metadata={"source": "mcp-client"}
)

result = await adapter.intercept_tool_call(
    tool_name="web_search",
    tool_args={
        "query": "Caracal project",
        "limit": 5
    },
    mcp_context=context
)

if result.success:
    print(f"Tool result: {result.result}")
else:
    print(f"Authorization Denied: {result.error}")
```

## Integration Satisfied

This implementation satisfies the following requirements for authority enforcement:

- **Requirement 11.1**: Intercept MCP tool invocation requests before execution.
- **Requirement 11.2**: Extract principal identity and mandate from MCP context.
- **Requirement 11.3**: Perform authority validation via MandateEvaluator.
- **Requirement 11.5**: Log authority decision to the immutable ledger.
- **Requirement 12.1**: Intercept MCP resource read requests for authorization.

## Architecture

```
┌──────────────────┐
│    MCP Client    │
└─────────┬────────┘
          │ (Request + Mandate)
          ▼
┌──────────────────┐
│    MCPAdapter    │◄───────┐
└─────────┬────────┘        │
          │                 │
          ├─────────────────┼──► MandateEvaluator (validate authority)
          │                 │
          ├─────────────────┼──► MCP Server (authorized execution)
          │                 │
          └─────────────────┴──► Authority Ledger (audit trail)
```

## Error Handling

The adapter implements **fail-closed semantics**:
- Invalid or expired mandates raise `AuthorityError` and deny execution.
- Missing principal identity or mandate in context results in immediate denial.
- Any error during the evaluation process results in a logged denial.

## Logging

The adapter logs to the standard Caracal log stream:
- Mandate validation requests (DEBUG)
- Authority decisions (INFO)
- Ledger entry confirmations (INFO)
- Validation errors or denials (WARNING/ERROR)

Configure logging level in your environment:
```bash
export CARACAL_LOG_LEVEL=INFO
```

