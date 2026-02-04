# MCP Adapter for Caracal Core

This module provides integration between Caracal budget enforcement and the Model Context Protocol (MCP) ecosystem.

## Overview

The MCP Adapter intercepts MCP tool calls and resource reads, enforces budget policies, and emits metering events. This enables budget enforcement for MCP-based agents.

## Components

### MCPAdapter

Main adapter class that coordinates budget enforcement for MCP operations.

**Key Methods:**
- `intercept_tool_call()`: Intercepts MCP tool invocations, checks budget, forwards to MCP server, and emits metering events
- `intercept_resource_read()`: Intercepts MCP resource reads, checks budget, fetches resource, and emits metering events

**Requirements Implemented:**
- 11.1: Intercept MCP tool invocation requests before execution
- 11.2: Extract agent identity from MCP context
- 11.3: Perform budget check via Caracal Core
- 11.4: Forward tool invocation to MCP server
- 11.5: Emit metering event with actual resource usage
- 12.1: Intercept MCP resource read requests
- 12.2: Calculate cost based on resource type and size
- 12.3: Emit metering event to Caracal Core

### MCPCostCalculator

Calculates costs for MCP operations based on the pricebook.

**Key Methods:**
- `estimate_tool_cost()`: Estimates cost for tool invocations
- `calculate_actual_tool_cost()`: Calculates actual cost from tool results
- `estimate_resource_cost()`: Estimates cost for resource reads

**Cost Estimation Strategies:**
- **LLM Tools**: Based on estimated token usage (input + output tokens)
- **API Tools**: Based on endpoint and data size
- **Resource Reads**: Based on resource type and size
- **Default**: Flat rate per operation

### MCPContext

Context information for MCP requests containing agent ID and metadata.

### MCPResult

Result of an MCP operation with success status, result data, and metadata.

### MCPResource

Represents an MCP resource with URI, content, MIME type, and size.

## Usage Example

```python
from caracal.mcp import MCPAdapter, MCPContext, MCPCostCalculator
from caracal.core.policy import PolicyEvaluator
from caracal.core.metering import MeteringCollector
from caracal.core.pricebook import Pricebook

# Initialize components
pricebook = Pricebook("pricebook.csv")
policy_evaluator = PolicyEvaluator(policy_store, ledger_query)
metering_collector = MeteringCollector(pricebook, ledger_writer)
cost_calculator = MCPCostCalculator(pricebook)

# Create MCP adapter
adapter = MCPAdapter(
    policy_evaluator=policy_evaluator,
    metering_collector=metering_collector,
    cost_calculator=cost_calculator
)

# Intercept tool call
context = MCPContext(
    agent_id="agent-uuid",
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
    print(f"Cost: {result.metadata['actual_cost']} USD")
else:
    print(f"Error: {result.error}")
```

## Pricebook Configuration

Add MCP-specific prices to your pricebook:

```csv
resource_type,price_per_unit,currency,updated_at
mcp.tool.default,0.01,USD,2024-01-01T00:00:00Z
mcp.resource.default,0.001,USD,2024-01-01T00:00:00Z
mcp.llm.gpt-4.input_tokens,0.00003,USD,2024-01-01T00:00:00Z
mcp.llm.gpt-4.output_tokens,0.00006,USD,2024-01-01T00:00:00Z
mcp.resource.file.per_mb,0.0001,USD,2024-01-01T00:00:00Z
mcp.api.default,0.001,USD,2024-01-01T00:00:00Z
```

## Testing

Unit tests: `tests/unit/test_mcp_adapter.py`
Integration tests: `tests/integration/test_mcp_integration.py`

Run tests:
```bash
pytest tests/unit/test_mcp_adapter.py -v
pytest tests/integration/test_mcp_integration.py -v
```

## Implementation Notes

### v0.2 Limitations

- MCP server forwarding is simulated (placeholder implementation)
- Actual HTTP/gRPC calls to MCP servers will be implemented in v0.3
- Resource fetching is simulated with placeholder content

### Future Enhancements (v0.3)

- Real MCP server integration via HTTP/gRPC
- Support for MCP prompt access metering
- Support for MCP sampling request metering
- Decorator pattern for in-process integration
- Standalone service deployment mode
- Advanced cost calculation rules
- Custom cost calculation functions per resource type

## Architecture

```
┌─────────────────┐
│   MCP Client    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   MCPAdapter    │◄──────┐
└────────┬────────┘       │
         │                │
         ├────────────────┼──► PolicyEvaluator (budget check)
         │                │
         ├────────────────┼──► MCPCostCalculator (cost estimation)
         │                │
         ├────────────────┼──► MCP Server (tool execution)
         │                │
         └────────────────┴──► MeteringCollector (emit events)
```

## Error Handling

The adapter implements fail-closed semantics:
- Budget check failures raise `BudgetExceededError`
- Missing agent ID raises `CaracalError`
- Other errors return `MCPResult` with `success=False` and error message
- Metering events are only emitted for successful operations

## Logging

The adapter logs:
- Tool call interceptions (DEBUG)
- Resource read interceptions (DEBUG)
- Cost estimations (DEBUG)
- Budget check results (INFO)
- Metering events (INFO)
- Errors (ERROR)

Configure logging level in your application:
```python
import logging
logging.getLogger("caracal.mcp").setLevel(logging.DEBUG)
```
