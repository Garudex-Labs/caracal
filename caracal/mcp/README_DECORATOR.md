# MCP Adapter Decorator - SDK Plugin Mode

## Overview

The MCP Adapter decorator provides a simple way to add Caracal budget enforcement and metering to MCP tool functions in SDK plugin mode. This allows developers to integrate Caracal directly into their Python applications without deploying a separate service.

## Requirements

Implements **Requirement 18.4**: "WHEN deployed as an SDK plugin, THE MCP_Adapter SHALL provide Python decorators for MCP tool functions"

## Features

- ✅ Automatic budget checks before tool execution
- ✅ Automatic metering events after tool execution  
- ✅ Support for both async and sync functions
- ✅ Flexible agent_id parameter handling
- ✅ Transparent error handling and logging
- ✅ Preserves function metadata (name, docstring)

## Usage

### Basic Usage

```python
from caracal.mcp.adapter import MCPAdapter
from caracal.mcp.cost_calculator import MCPCostCalculator
from caracal.core.policy import PolicyEvaluator
from caracal.core.metering import MeteringCollector
from caracal.core.pricebook import Pricebook

# Initialize Caracal components
pricebook = Pricebook()
policy_evaluator = PolicyEvaluator(...)
metering_collector = MeteringCollector(...)
cost_calculator = MCPCostCalculator(pricebook)

# Create MCP adapter
mcp_adapter = MCPAdapter(
    policy_evaluator=policy_evaluator,
    metering_collector=metering_collector,
    cost_calculator=cost_calculator
)

# Decorate your MCP tool function
@mcp_adapter.as_decorator()
async def my_mcp_tool(agent_id: str, param1: str, param2: int):
    """Your MCP tool implementation."""
    # Tool logic here
    return {"result": f"{param1}_{param2}"}

# Use the decorated tool
result = await my_mcp_tool(
    agent_id="agent-123",
    param1="test",
    param2=42
)
```

### Agent ID Parameter

The decorator requires an `agent_id` parameter to identify which agent is making the request. This can be provided in several ways:

#### 1. As a keyword argument (recommended)

```python
@mcp_adapter.as_decorator()
async def my_tool(param1: str, param2: int):
    return {"result": f"{param1}_{param2}"}

# Call with agent_id as kwarg
result = await my_tool(agent_id="agent-123", param1="test", param2=42)
```

#### 2. As the first positional argument

```python
@mcp_adapter.as_decorator()
async def my_tool(agent_id: str, param1: str, param2: int):
    return {"result": f"{param1}_{param2}"}

# Call with agent_id as first arg
result = await my_tool("agent-123", param1="test", param2=42)
```

#### 3. Using alternative parameter names

The decorator also recognizes these parameter names:
- `agent_id` (preferred)
- `agent`
- `caracal_agent_id`

```python
result = await my_tool(agent="agent-123", param1="test", param2=42)
# or
result = await my_tool(caracal_agent_id="agent-123", param1="test", param2=42)
```

### Synchronous Functions

The decorator works with both async and sync functions:

```python
@mcp_adapter.as_decorator()
def sync_tool(agent_id: str, data: str):
    """Synchronous tool."""
    import hashlib
    return hashlib.sha256(data.encode()).hexdigest()

# Still use await when calling (decorator handles the conversion)
result = await sync_tool(agent_id="agent-123", data="hello")
```

## How It Works

When you call a decorated function, the decorator:

1. **Extracts agent_id** from the function arguments
2. **Estimates cost** using the MCPCostCalculator based on tool name and arguments
3. **Checks budget** via PolicyEvaluator to ensure agent has sufficient budget
4. **Executes the tool** if budget check passes
5. **Calculates actual cost** from the tool result
6. **Emits metering event** to the ledger with actual cost and provisional charge ID
7. **Returns the result** to the caller

If the budget check fails, a `BudgetExceededError` is raised before the tool executes.

## Error Handling

### Budget Exceeded

```python
from caracal.exceptions import BudgetExceededError

try:
    result = await my_tool(agent_id="agent-123", param1="test")
except BudgetExceededError as e:
    print(f"Budget exceeded: {e}")
    # Handle budget error
```

### Missing Agent ID

```python
from caracal.exceptions import CaracalError

try:
    result = await my_tool(param1="test")  # Missing agent_id
except CaracalError as e:
    print(f"Error: {e}")
    # Handle missing agent_id
```

### Tool Execution Errors

```python
from caracal.exceptions import CaracalError

try:
    result = await my_tool(agent_id="agent-123", param1="test")
except CaracalError as e:
    print(f"Tool execution failed: {e}")
    # Handle tool error
```

## Examples

### LLM Tool

```python
@mcp_adapter.as_decorator()
async def llm_completion(agent_id: str, prompt: str, model: str = "gpt-4", max_tokens: int = 1000):
    """Generate LLM completion."""
    # Call LLM API
    response = await llm_api.complete(
        prompt=prompt,
        model=model,
        max_tokens=max_tokens
    )
    return {
        "completion": response.text,
        "tokens_used": response.usage.total_tokens,
        "model": model
    }

# Use the tool
result = await llm_completion(
    agent_id="agent-123",
    prompt="Explain quantum computing",
    model="gpt-4",
    max_tokens=500
)
```

### Database Query Tool

```python
@mcp_adapter.as_decorator()
async def query_database(agent_id: str, sql: str, database: str = "main"):
    """Execute a database query."""
    # Execute query
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(sql)
    
    return {
        "rows": [dict(row) for row in rows],
        "count": len(rows)
    }

# Use the tool
result = await query_database(
    agent_id="agent-123",
    sql="SELECT * FROM users WHERE active = true",
    database="analytics"
)
```

### File Processing Tool

```python
@mcp_adapter.as_decorator()
async def process_file(agent_id: str, file_path: str, operation: str):
    """Process a file."""
    # Read and process file
    async with aiofiles.open(file_path, 'r') as f:
        content = await f.read()
    
    if operation == "count_words":
        word_count = len(content.split())
        return {"word_count": word_count}
    elif operation == "count_lines":
        line_count = len(content.splitlines())
        return {"line_count": line_count}
    else:
        raise ValueError(f"Unknown operation: {operation}")

# Use the tool
result = await process_file(
    agent_id="agent-123",
    file_path="/data/document.txt",
    operation="count_words"
)
```

## Comparison with Service Mode

| Feature | Decorator (SDK Plugin) | Standalone Service |
|---------|----------------------|-------------------|
| Deployment | In-process | Separate container |
| Network overhead | None | HTTP/gRPC calls |
| Language support | Python only | Any language |
| Integration effort | Low (just add decorator) | Medium (configure proxy) |
| Scalability | Scales with app | Independent scaling |
| Use case | Single application | Multiple applications |

## Best Practices

1. **Always provide agent_id**: The decorator requires agent_id to track spending
2. **Use descriptive tool names**: Function names become tool names in metering events
3. **Handle budget errors**: Catch `BudgetExceededError` and provide user feedback
4. **Test with mocked components**: Use mocks for PolicyEvaluator and MeteringCollector in tests
5. **Monitor metering events**: Check that events are being emitted correctly
6. **Configure cost calculator**: Set appropriate prices in the pricebook for your tools

## Testing

### Unit Testing with Mocks

```python
import pytest
from unittest.mock import Mock
from decimal import Decimal
from uuid import uuid4

from caracal.mcp.adapter import MCPAdapter
from caracal.core.policy import PolicyDecision

@pytest.fixture
def mcp_adapter():
    # Create mocked components
    mock_policy_evaluator = Mock()
    mock_policy_evaluator.check_budget = Mock(return_value=PolicyDecision(
        allowed=True,
        reason="Within budget",
        remaining_budget=Decimal("100.00"),
        provisional_charge_id=str(uuid4())
    ))
    
    mock_metering_collector = Mock()
    mock_cost_calculator = Mock()
    mock_cost_calculator.estimate_tool_cost = Mock(return_value=Decimal("0.01"))
    mock_cost_calculator.calculate_actual_tool_cost = Mock(return_value=Decimal("0.01"))
    
    return MCPAdapter(
        policy_evaluator=mock_policy_evaluator,
        metering_collector=mock_metering_collector,
        cost_calculator=mock_cost_calculator
    )

@pytest.mark.asyncio
async def test_decorated_tool(mcp_adapter):
    @mcp_adapter.as_decorator()
    async def test_tool(agent_id: str, param: str):
        return {"result": param}
    
    result = await test_tool(agent_id="agent-123", param="test")
    assert result == {"result": "test"}
```

## Troubleshooting

### "agent_id is required" error

**Problem**: The decorator can't find the agent_id parameter.

**Solution**: Ensure you're passing agent_id as either:
- A keyword argument: `my_tool(agent_id="...", ...)`
- The first positional argument: `my_tool("agent-123", ...)`

### Budget check not being called

**Problem**: PolicyEvaluator.check_budget is not being invoked.

**Solution**: Verify that:
- The PolicyEvaluator is properly initialized
- The decorator is applied correctly with `@mcp_adapter.as_decorator()`
- The function is actually being called

### Metering events not appearing

**Problem**: Events are not being written to the ledger.

**Solution**: Check that:
- MeteringCollector is properly initialized
- The collector's `collect_event` method is working
- Database connection is active (if using PostgreSQL backend)

## See Also

- [MCP Adapter Service Mode](./README.md) - Standalone service deployment
- [Cost Calculator](./cost_calculator.py) - Cost estimation for MCP tools
- [Policy Evaluator](../core/policy.py) - Budget policy enforcement
- [Metering Collector](../core/metering.py) - Event collection and ledger writing
