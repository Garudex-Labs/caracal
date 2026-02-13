# SDK Integration

Integrate Caracal's authority enforcement directly into your Python applications using the Caracal SDK.

## Overview

The SDK provides a `AuthorityClient` class that allows your application to:

-   Request Mandates
-   Validate Mandates
-   Manage Principals and Policies

## Connecting to Caracal Enterprise

The `AuthorityClient` requires your Enterprise URL and an API Key.

```python
import os
from caracal.sdk import AuthorityClient

client = AuthorityClient(
    base_url=os.environ["CARACAL_AUTHORITY_URL"],
    api_key=os.environ.get("CARACAL_API_KEY"),
)
```

## Requesting a Mandate

Before performing any action that requires authority, your agent must request a mandate. A mandate is a time-bound token granting permission to perform specific actions on specific resources.

```python
# Issue a mandate
mandate = client.request_mandate(
    issuer_id="<issuer-principal-id>",
    subject_id="<subject-principal-id>",
    resource_scope=["api:external/*"],
    action_scope=["read", "write"],
    validity_seconds=3600,  # Valid for 1 hour
    intent={
        "purpose": "External API integration",
        "requested_by": "user@example.com"
    }
)

print(f"Mandate issued: {mandate['mandate_id']}")
print(f"Valid until: {mandate['valid_until']}")
```

## Validating a Mandate

Within your critical execution paths, **always** validate the mandate before proceeding.

```python
def execute_external_api_call(mandate_id: str, endpoint: str):
    # ALWAYS validate mandate before execution
    validation = client.validate_mandate(
        mandate_id=mandate_id,
        requested_action="read",
        requested_resource=f"api:external/{endpoint}"
    )
    
    if not validation["allowed"]:
        raise PermissionError(
            f"Authority denied: {validation['denial_reason']}"
        )
    
    # Authority validated - proceed with execution
    result = make_api_call(endpoint)
    return result
```

## Error Handling

The SDK raises specific exceptions for common issues:

-   `AuthenticationError`: Invalid API key.
-   `PermissionError`: The requested action is not allowed by policy.
-   `ConnectionError`: Cannot reach the Caracal Enterprise server.
