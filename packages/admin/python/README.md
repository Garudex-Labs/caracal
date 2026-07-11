# caracalai-admin

Caracal admin client for Python: a `ControlClient` that mints a scoped, single-use token per governed control invoke, an `AdminClient` over the Caracal admin API, and idempotent `ensure_*` reconcilers that converge applications, providers, resources, policy sets, and grants to a desired state.

```python
from caracalai_admin import AdminClient, ensure_grants, ResourceGrant

client = AdminClient(api_url="http://localhost:9090", admin_token="...")
ensure_grants(
    client,
    "zone-id",
    grants=[
        ResourceGrant(
            application_id="app-anton",
            resource_identifier="resource://pipernet",
            scopes=["data:read"],
        )
    ],
)
```

Part of [Caracal](https://github.com/Garudex-Labs/caracal). Apache-2.0.
