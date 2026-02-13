# MCP Adapter Decorator -- SDK Plugin Mode

## Overview

The MCP Adapter decorator provides a simple way to add Caracal authority enforcement to MCP tool functions in SDK plugin mode. This allows developers to integrate Caracal directly into their Python applications without deploying a separate service.

## Features

- Automatic mandate validation before tool execution
- Automatic authority event recording after execution
- Support for both async and sync functions
- Flexible principal_id parameter handling
- Fail-closed error handling
- Preserves function metadata (name, docstring)

## Usage

### Basic Usage

```python
from caracal.mcp.adapter import MCPAdapter
from caracal.core.authority import AuthorityEnforcer
from caracal.core.ledger import LedgerWriter

# Initialize Caracal components
authority_enforcer = AuthorityEnforcer(...)
ledger_writer = LedgerWriter(...)

# Create MCP adapter
mcp_adapter = MCPAdapter(
    authority_enforcer=authority_enforcer,
    ledger_writer=ledger_writer
)

# Decorate your MCP tool function
@mcp_adapter.as_decorator()
async def my_mcp_tool(principal_id: str, param1: str, param2: int):
    """Your MCP tool implementation."""
    return {"result": f"{param1}_{param2}"}

# Use the decorated tool
result = await my_mcp_tool(
    principal_id="principal-123",
    param1="test",
    param2=42
)
```

### Principal ID Parameter

The decorator requires a `principal_id` parameter to identify which principal is making the request:

```python
# As a keyword argument (recommended)
result = await my_tool(principal_id="principal-123", param1="test")

# As the first positional argument
result = await my_tool("principal-123", param1="test")
```

The decorator recognizes these parameter names:
- `principal_id` (preferred)
- `agent_id` (backward compatibility)

## How It Works

When you call a decorated function, the decorator:

1. **Extracts principal_id** from the function arguments
2. **Validates mandate** via AuthorityEnforcer for the requested resource
3. **Executes the tool** if authority check passes
4. **Records authority event** in the ledger
5. **Returns the result** to the caller

If the authority check fails, an `AuthorityDeniedError` is raised before the tool executes.

## Error Handling

### Authority Denied

```python
from caracal.exceptions import AuthorityDeniedError

try:
    result = await my_tool(principal_id="principal-123", param1="test")
except AuthorityDeniedError as e:
    print(f"Authority denied: {e}")
```

### Missing Principal ID

```python
from caracal.exceptions import CaracalError

try:
    result = await my_tool(param1="test")  # Missing principal_id
except CaracalError as e:
    print(f"Error: {e}")
```

## Examples

### LLM Tool

```python
@mcp_adapter.as_decorator()
async def llm_completion(principal_id: str, prompt: str, model: str = "gpt-4"):
    """Generate LLM completion."""
    response = await llm_api.complete(prompt=prompt, model=model)
    return {"completion": response.text, "model": model}
```

### Database Query Tool

```python
@mcp_adapter.as_decorator()
async def query_database(principal_id: str, sql: str, database: str = "main"):
    """Execute a database query."""
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(sql)
    return {"rows": [dict(row) for row in rows], "count": len(rows)}
```

## Comparison with Service Mode

| Feature | Decorator (SDK Plugin) | Standalone Service |
|---------|----------------------|-------------------|
| Deployment | In-process | Separate container |
| Network overhead | None | HTTP/gRPC calls |
| Language support | Python only | Any language |
| Integration effort | Low (just add decorator) | Medium (configure proxy) |
| Scalability | Scales with app | Independent scaling |

## Best Practices

1. **Always provide principal_id**: Required for authority enforcement
2. **Use descriptive tool names**: Function names become resource identifiers in authority events
3. **Handle authority errors**: Catch `AuthorityDeniedError` and provide user feedback
4. **Test with mocked components**: Use mocks for AuthorityEnforcer and LedgerWriter in tests

## See Also

- [MCP Adapter Service Mode](./mcpIntegration) -- Standalone service deployment
- [SDK Client](./sdkClient) -- Authority enforcement SDK
