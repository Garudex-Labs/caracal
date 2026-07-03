# caracalai-asgi

ASGI middleware for Caracal mandate verification. Protects FastAPI, Starlette, Quart, and any other ASGI application with fail-closed verification of Caracal-issued mandates.

Part of [Caracal](https://github.com/Garudex-Labs/caracal): the identity and authorization layer for AI agents - short-lived, policy-approved authority instead of credentials.

## Install

```bash
pip install caracalai-asgi
```

## Use

```python
from caracalai_asgi import CaracalASGIAuth
from caracalai_revocation import InMemoryRevocationStore
from fastapi import FastAPI

app = FastAPI()
app.add_middleware(
    CaracalASGIAuth,
    audience="resource://billing-api",
    revocations=InMemoryRevocationStore(),
    routes={"/payouts": {"required_scopes": ["billing:payout"], "require_delegation": True}},
    exclude=["/healthz"],
)
```

The issuer defaults to `CARACAL_STS_URL` and the zone to `CARACAL_ZONE_ID`. Verified claims are available as `request.state.caracal`.

## Links

- Source: https://github.com/Garudex-Labs/caracal
- Docs: https://caracal.run/guides/protect-fastapi/
- License: Apache-2.0
