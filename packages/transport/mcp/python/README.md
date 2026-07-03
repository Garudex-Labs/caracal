# caracalai-transport-mcp

Transport-neutral MCP authentication for Caracal-issued JWTs.

Part of [Caracal](https://github.com/Garudex-Labs/caracal): the identity and authorization layer for AI agents - short-lived, policy-approved authority instead of credentials.

## Install

```bash
pip install caracalai-transport-mcp
```

## Verify a mandate

```python
from caracalai_revocation import InMemoryRevocationStore
from caracalai_transport_mcp import AuthOptions, create_mandate_verifier

verifier = create_mandate_verifier(
    AuthOptions(
        issuer="https://sts.example.com",
        audience="https://api.example.com",
        expected_zone_id="zone_prod",
        revocations=InMemoryRevocationStore(),
    )
)

result = await verifier.authorization(
    request.headers.get("authorization"),
    required_scopes=["tickets:read"],
    required_targets=["https://api.example.com/tickets"],
)
```

## Links

- Source: https://github.com/Garudex-Labs/caracal
- Docs: https://caracal.run/sdks/transport-mcp/
- License: Apache-2.0
