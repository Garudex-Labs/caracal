# Caracal SDK

> Pre-execution authority enforcement SDK for delegated principals.  
> Standalone package: `caracal-sdk` · License: Apache-2.0

## Installation

```bash
pip install caracal-sdk
```

## Quick Start

```python
from caracal_sdk import CaracalClient

client = CaracalClient(api_key="sk_test_123")

# Route tool execution through Caracal runtime
result = await client.tools.call(
    tool_id="provider:github:resource:issues:action:create",
    mandate_id="mandate_123",
    tool_args={"title": "Investigate regression"},
)
```

## Scoped Runtime Calls

```python
from caracal_sdk import CaracalClient

client = CaracalClient(api_key="sk_test_123")

# Checkout a specific scope
ctx = client.context.checkout(
    organization_id="org_abc123",
    workspace_id="ws_xyz789",
)

# Tool calls automatically include scope headers
result = await ctx.tools.call(
    tool_id="provider:slack:resource:messages:action:post",
    mandate_id="mandate_123",
    tool_args={"channel": "alerts", "text": "Runtime check complete"},
)

# Switch context explicitly
other_ctx = client.context.checkout(
    organization_id="org_abc123",
    workspace_id="ws_other",
)
```

## Advanced Builder Mode

```python
from caracal_sdk import CaracalBuilder
from caracal_sdk.adapters import WebSocketAdapter
from caracal_sdk.enterprise.compliance import ComplianceExtension
from caracal_sdk.enterprise.analytics import AnalyticsExtension

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
| **Client**     | `caracal_sdk.client`     | Init, builder, config      |
| **Context**    | `caracal_sdk.context`    | Org/Workspace scope        |
| **Tools**      | `caracal_sdk.tools`      | MCP tool-call bridge       |
| **Adapters**   | `caracal_sdk.adapters`   | Transport (HTTP, WS, Mock) |
| **Hooks**      | `caracal_sdk.hooks`      | Lifecycle events           |
| **Extensions** | `caracal_sdk.extensions` | Plugin interface           |
| **AIS**        | `caracal_sdk.ais`        | Runtime endpoint resolver  |

## Removed From SDK Surface

The SDK intentionally does not expose control-plane CRUD APIs.

- No principal CRUD operations.
- No mandate or delegation lifecycle operations.
- No policy or ledger management APIs.

Control-plane ownership remains in Caracal runtime, broker, and enterprise gateway layers.

## Writing Extensions

```python
from caracal_sdk.extensions import CaracalExtension
from caracal_sdk.hooks import HookRegistry

class MyExtension(CaracalExtension):
    @property
    def name(self) -> str:
        return "my-extension"

    @property
    def version(self) -> str:
        try:
            from importlib import resources
            return resources.files("caracal").joinpath("VERSION").read_text().strip()
        except Exception:
            return "unknown"

    def install(self, hooks: HookRegistry) -> None:
        hooks.on_before_request(self._inject_header)

    def _inject_header(self, request, scope):
        request.headers["X-Custom"] = "value"
        return request
```

## Enterprise Extensions

Premium extensions in `caracal_sdk.enterprise`:

- **ComplianceExtension** — SOC 2, ISO 27001, GDPR
- **AnalyticsExtension** — Advanced export + dashboard
- **WorkflowsExtension** — Event-driven automation

## Error Handling

The SDK uses fail-closed semantics. Errors raise exceptions rather than silently failing:

```python
from caracal_sdk import CaracalClient
from caracal_sdk._compat import SDKConfigurationError

try:
    client = CaracalClient(api_key="sk_test_123")
    result = await client.tools.call(
        tool_id="provider:demo:resource:jobs:action:run",
        mandate_id="m_1",
    )
except SDKConfigurationError as e:
    print(f"Config error: {e}")
```

## Requirements

- Python 3.10+
- httpx (for HTTP transport)

## License

Apache-2.0 — see LICENSE in repository root.  
Enterprise extensions (`caracal_sdk/enterprise/`) are proprietary.
