# Caracal SDK

The Caracal SDK provides a developer-friendly Python API for integrating budget checks and metering into AI agent applications.

## Features

- **Configuration Management**: Automatic loading of Caracal configuration
- **Component Integration**: Seamless integration with all Caracal Core components
- **Event Emission**: Direct metering event emission with cost calculation
- **Budget Checking**: Simple budget verification methods
- **Fail-Closed Semantics**: Automatic denial on errors to prevent unchecked spending
- **Clear Error Messages**: Comprehensive error handling with informative messages

## Installation

```bash
pip install caracal-core
```

## Quick Start

```python
from decimal import Decimal
from caracal.sdk.client import CaracalClient

# Initialize client (uses default config at ~/.caracal/config.yaml)
client = CaracalClient()

# Or specify custom config path
client = CaracalClient(config_path="/path/to/config.yaml")

# Check if agent is within budget
if client.check_budget("my-agent-id"):
    # Proceed with expensive operation
    result = call_expensive_api()
    
    # Emit metering event
    client.emit_event(
        agent_id="my-agent-id",
        resource_type="openai.gpt-5.2.input_tokens",
        quantity=Decimal("1"),
        metadata={"model": "gpt-5.2"}
    )
```

## API Reference

### CaracalClient

Main SDK client class for interacting with Caracal Core.

#### `__init__(config_path: Optional[str] = None)`

Initialize the Caracal SDK client.

**Parameters:**
- `config_path` (optional): Path to configuration file. If None, uses default path `~/.caracal/config.yaml`.

**Raises:**
- `ConnectionError`: If initialization fails (fail-closed)
- `SDKConfigurationError`: If configuration is invalid

**Example:**
```python
# Use default configuration
client = CaracalClient()

# Use custom configuration
client = CaracalClient(config_path="/etc/caracal/config.yaml")
```

#### `emit_event(agent_id: str, resource_type: str, quantity: Decimal, metadata: Optional[Dict] = None)`

Emit a metering event directly.

**Parameters:**
- `agent_id`: Agent identifier
- `resource_type`: Type of resource consumed (e.g., "openai.gpt-5.2.input_tokens")
- `quantity`: Amount of resource consumed (as Decimal)
- `metadata` (optional): Additional context for the event

**Raises:**
- `ConnectionError`: If event emission fails (fail-closed)

**Example:**
```python
from decimal import Decimal

client.emit_event(
    agent_id="my-agent-id",
    resource_type="openai.gpt-5.2.input_tokens",
    quantity=Decimal("1"),
    metadata={
        "model": "gpt-5.2",
        "request_id": "req_123",
        "user": "user@example.com"
    }
)
```

#### `check_budget(agent_id: str) -> bool`

Check if an agent is within budget.

**Parameters:**
- `agent_id`: Agent identifier

**Returns:**
- `True` if agent is within budget, `False` otherwise

**Fail-Closed Behavior:**
- Returns `False` if budget check fails
- Returns `False` if no policy exists for agent
- Returns `False` on any error

**Example:**
```python
if client.check_budget("my-agent-id"):
    # Agent is within budget, proceed
    result = call_expensive_api()
else:
    # Agent exceeded budget or check failed
    print("Budget exceeded or check failed")
```

#### `get_remaining_budget(agent_id: str) -> Optional[Decimal]`

Get the remaining budget for an agent.

**Parameters:**
- `agent_id`: Agent identifier

**Returns:**
- Remaining budget as `Decimal`, or `None` if check fails

**Fail-Closed Behavior:**
- Returns `None` if budget check fails
- Returns `Decimal('0')` if agent has no remaining budget

**Example:**
```python
remaining = client.get_remaining_budget("my-agent-id")

if remaining and remaining > Decimal("10.00"):
    # Sufficient budget remaining
    result = call_expensive_api()
else:
    # Insufficient budget or check failed
    print(f"Insufficient budget: {remaining}")
```

## Fail-Closed Semantics

The SDK implements fail-closed semantics to prevent unchecked spending:

1. **Initialization Failures**: If the client cannot initialize (e.g., missing configuration, component failures), it raises `ConnectionError` immediately.

2. **Event Emission Failures**: If event emission fails, the SDK raises `ConnectionError` to alert the caller that the event was not recorded.

3. **Budget Check Failures**: If budget checks fail (e.g., policy evaluation error, ledger query error), the SDK returns `False` to deny the operation.

4. **Missing Policies**: If no policy exists for an agent, budget checks return `False` (deny).

This ensures that errors always result in denial rather than allowing potentially over-budget execution.

## Error Handling

The SDK provides clear error messages for all failure modes:

```python
from caracal.exceptions import ConnectionError, BudgetExceededError

try:
    client = CaracalClient(config_path="/invalid/path.yaml")
except ConnectionError as e:
    print(f"Failed to initialize client: {e}")

try:
    client.emit_event(
        agent_id="my-agent-id",
        resource_type="openai.gpt4.input_tokens",
        quantity=Decimal("1000")
    )
except ConnectionError as e:
    print(f"Failed to emit event: {e}")
```

## Configuration

The SDK loads configuration from a YAML file. See the main Caracal documentation for configuration details.

Example configuration:

```yaml
storage:
  agent_registry: ~/.caracal/agents.json
  policy_store: ~/.caracal/policies.json
  ledger: ~/.caracal/ledger.jsonl
  pricebook: ~/.caracal/pricebook.csv
  backup_dir: ~/.caracal/backups
  backup_count: 3

defaults:
  currency: USD
  time_window: daily

logging:
  level: INFO
  file: ~/.caracal/caracal.log
```

## Examples

See `examples/sdk_client_demo.py` for a complete demonstration of SDK usage.

## Requirements Satisfied

This SDK implementation satisfies the following requirements:

- **Requirement 7.5**: Provides `emit_event()` function for direct event emission
- **Requirement 7.6**: Implements fail-closed semantics for connection errors

## Future Enhancements

The following features are planned for future releases:

- **Context Manager** (v0.1): Budget check context manager for wrapping agent code (Task 13)
- **Async Support** (v0.2): Async/await support for non-blocking operations
- **Batch Operations** (v0.2): Batch event emission for improved performance
- **Retry Logic** (v0.2): Automatic retry with exponential backoff for transient failures
- **Metrics Collection** (v0.3): Built-in metrics for SDK usage monitoring
