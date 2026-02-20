# Caracal SDK

> Pre-execution authority enforcement SDK for AI agents.  
> Part of `caracal-core` · License: AGPLv3

## Installation

```bash
pip install caracal-core
```

## Quick Start

```python
from caracal.sdk import CaracalClient

client = CaracalClient(api_key="sk_test_123")

# List agents
agents = await client.agents.list()

# Create a mandate
mandate = await client.mandates.create(
    agent_id="agent_001",
    allowed_operations=["read", "write"],
    expires_in=3600,
)
```

## Workspace-Scoped Operations

```python
from caracal.sdk import CaracalClient

client = CaracalClient(api_key="sk_test_123")

# Checkout a specific scope
ctx = client.context.checkout(
    organization_id="org_abc123",
    workspace_id="ws_xyz789",
)

# All operations are scoped
agents = await ctx.agents.list()
mandate = await ctx.mandates.create(
    agent_id="agent_001",
    allowed_operations=["read"],
    expires_in=3600,
)

# Switch context explicitly
other_ctx = client.context.checkout(
    organization_id="org_abc123",
    workspace_id="ws_other",
)
```

## Advanced Builder Mode

```python
from caracal.sdk import CaracalBuilder
from caracal.sdk.adapters import WebSocketAdapter
from caracal.sdk.enterprise.compliance import ComplianceExtension
from caracal.sdk.enterprise.analytics import AnalyticsExtension

client = (
    CaracalBuilder()
    .set_transport(WebSocketAdapter(url="wss://caracal.internal:8443"))
    .use(ComplianceExtension(standard="soc2", auto_report=True))
    .use(AnalyticsExtension(export_interval=300))
    .build()
)
```

## SDK Modules

| Module         | Import                   | Responsibility             |
| -------------- | ------------------------ | -------------------------- |
| **Client**     | `caracal.sdk.client`     | Init, builder, config      |
| **Context**    | `caracal.sdk.context`    | Org/Workspace scope        |
| **Agents**     | `caracal.sdk.agents`     | Agent CRUD                 |
| **Mandates**   | `caracal.sdk.mandates`   | Mandate lifecycle          |
| **Delegation** | `caracal.sdk.delegation` | Token management           |
| **Ledger**     | `caracal.sdk.ledger`     | Audit queries              |
| **Adapters**   | `caracal.sdk.adapters`   | Transport (HTTP, WS, Mock) |
| **Hooks**      | `caracal.sdk.hooks`      | Lifecycle events           |
| **Extensions** | `caracal.sdk.extensions` | Plugin interface           |

## Writing Extensions

```python
from caracal.sdk.extensions import CaracalExtension
from caracal.sdk.hooks import HookRegistry

class MyExtension(CaracalExtension):
    @property
    def name(self) -> str:
        return "my-extension"

    @property
    def version(self) -> str:
        return "1.0.0"

    def install(self, hooks: HookRegistry) -> None:
        hooks.on_before_request(self._inject_header)

    def _inject_header(self, request, scope):
        request.headers["X-Custom"] = "value"
        return request
```

## Enterprise Extensions

Premium extensions in `caracal.sdk.enterprise`:

- **ComplianceExtension** — SOC 2, ISO 27001, GDPR, HIPAA
- **AnalyticsExtension** — Advanced export + dashboard
- **WorkflowsExtension** — Event-driven automation
- **HealthcareExtension** / **FinanceExtension** — Regulated industries

## Error Handling

The SDK uses fail-closed semantics. Errors raise exceptions rather than silently failing:

```python
from caracal.sdk import CaracalClient
from caracal.exceptions import SDKConfigurationError

try:
    client = CaracalClient(api_key="sk_test_123")
    agents = await client.agents.list()
except SDKConfigurationError as e:
    print(f"Config error: {e}")
```

## Migration from v0.1

```python
# OLD (deprecated, still works with warning):
client = CaracalClient(config_path="/path/to/config.toml")

# NEW:
client = CaracalClient(api_key="sk_test_123")
```

## Requirements

- Python 3.10+
- httpx (for HTTP transport)

## License

AGPLv3 — see LICENSE in repository root.  
Enterprise extensions (`sdk/enterprise/`) are proprietary.
