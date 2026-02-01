# Caracal Core

Economic control plane for AI agents.

## Overview

Caracal Core is an open-source economic infrastructure layer for AI agents that provides:

- **Economic Identity**: Unique identifiers for agents with ownership metadata
- **Budget Policies**: Spending limits with time-based constraints
- **Policy Enforcement**: Fail-closed budget checks before agent execution
- **Immutable Ledger**: Append-only audit trail of all spending events
- **Metering**: Resource usage tracking with cost calculation

## Installation

### Using uv (recommended)

```bash
# Create virtual environment
uv venv

# Activate virtual environment
source .venv/bin/activate  # On Unix/macOS
# or
.venv\Scripts\activate  # On Windows

# Install Caracal Core
uv pip install -e .

# Install with development dependencies
uv pip install -e ".[dev]"
```

### Using pip

```bash
pip install caracal-core
```

## Quick Start

### Initialize Caracal

```bash
caracal init
```

This creates the `~/.caracal/` directory with default configuration.

### Register an Agent

```bash
caracal agent register --name "my-agent" --owner "user@example.com"
```

### Create a Budget Policy

```bash
caracal policy create --agent-id <agent-id> --limit 100.00 --window daily
```

### Use the SDK

```python
from caracal.sdk.client import CaracalClient

client = CaracalClient()

# Budget check context manager
with client.budget_check(agent_id="my-agent"):
    # Your agent code here
    result = call_expensive_api()

# Emit metering event
client.emit_event(
    agent_id="my-agent",
    resource_type="openai.gpt4.input_tokens",
    quantity=1000
)
```

### Query the Ledger

```bash
# Query by agent
caracal ledger query --agent-id <agent-id>

# Query by date range
caracal ledger query --start 2024-01-01 --end 2024-01-31

# Get spending summary
caracal ledger summary --agent-id <agent-id>
```

## Development

### Running Tests

```bash
# Run all tests
pytest

# Run unit tests only
pytest tests/unit/

# Run property-based tests
pytest tests/property/ -m property

# Run with coverage
pytest --cov=caracal --cov-report=html
```

### Code Quality

```bash
# Format code
black caracal/ tests/

# Lint code
ruff caracal/ tests/

# Type checking
mypy caracal/
```

## Architecture

Caracal Core follows a modular architecture:

- `caracal.core`: Core primitives (identity, policy, ledger, metering)
- `caracal.sdk`: Python SDK for agent integration
- `caracal.cli`: Command-line interface
- `caracal.config`: Configuration management

## Requirements

- Python 3.10+
- Dependencies: click, pyyaml, hypothesis, ase-protocol

## License

Apache License 2.0 - See LICENSE file for details.

## Contributing

Contributions are welcome! Please see CONTRIBUTING.md for guidelines.
