---
sidebar_position: 1
title: SDK Client
---

# Caracal SDK

Python SDK for integrating authority enforcement into AI agent applications.

---

## Installation

```bash
pip install caracal-core
```

---

## Quick Start

```python
from caracal.sdk import AuthorityClient

client = AuthorityClient(
    base_url="https://your-caracal-instance.example.com",
    api_key="your-api-key"
)

# Request a mandate
mandate = client.request_mandate(
    issuer_id="<issuer-principal-id>",
    subject_id="<subject-principal-id>",
    resource_scope=["api:external/*"],
    action_scope=["read"],
    validity_seconds=3600
)

# Validate mandate before execution
validation = client.validate_mandate(
    mandate_id=mandate["mandate_id"],
    requested_action="read",
    requested_resource="api:external/data"
)

if validation["allowed"]:
    result = call_external_api()
```

---

## Configuration

### Configuration File

Default location: `~/.caracal/config.yaml`

```yaml
storage:
  agent_registry: ~/.caracal/agents.json
  policy_store: ~/.caracal/policies.json
  ledger: ~/.caracal/ledger.jsonl
  backup_dir: ~/.caracal/backups
  backup_count: 3

logging:
  level: INFO
  file: ~/.caracal/caracal.log
```

### Custom Configuration Path

```python
client = AuthorityClient(config_path="/etc/caracal/config.yaml")
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CARACAL_CONFIG` | Override default config path |
| `CARACAL_AUTHORITY_URL` | Authority enforcement backend URL |
| `CARACAL_API_KEY` | API key for authentication |

---

## API Reference

### AuthorityClient

Main SDK client class.

#### Constructor

```python
AuthorityClient(
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
    config_path: Optional[str] = None
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `base_url` | str | env var | Caracal authority URL |
| `api_key` | str | env var | API key |
| `config_path` | str | `~/.caracal/config.yaml` | Path to configuration file |

---

### Methods Overview

| Method | Description | Returns |
|--------|-------------|---------|
| `request_mandate()` | Issue a new execution mandate | Dict |
| `validate_mandate()` | Validate a mandate for an action | Dict |
| `revoke_mandate()` | Revoke an existing mandate | None |
| `register_principal()` | Register a new principal | Dict |
| `create_policy()` | Create an authority policy | Dict |
| `health_check()` | Check connection status | Dict |

---

### request_mandate

Issue a new execution mandate for a principal.

```python
request_mandate(
    issuer_id: str,
    subject_id: str,
    resource_scope: List[str],
    action_scope: List[str],
    validity_seconds: int,
    intent: Optional[Dict] = None
) -> Dict
```

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `issuer_id` | str | Yes | Principal issuing the mandate |
| `subject_id` | str | Yes | Principal receiving the mandate |
| `resource_scope` | List[str] | Yes | Resources the mandate grants access to |
| `action_scope` | List[str] | Yes | Actions the mandate permits |
| `validity_seconds` | int | Yes | How long the mandate is valid |
| `intent` | Dict | No | Declared purpose for the mandate |

**Returns:** Dictionary with `mandate_id`, `valid_until`, `signature`.

<details>
<summary>Example</summary>

```python
mandate = client.request_mandate(
    issuer_id="<issuer-principal-id>",
    subject_id="<agent-principal-id>",
    resource_scope=["api:external/*"],
    action_scope=["read", "write"],
    validity_seconds=3600,
    intent={
        "purpose": "External API integration",
        "requested_by": "user@example.com"
    }
)

print(f"Mandate issued: {mandate['mandate_id']}")
print(f"Valid until: {mandate['valid_until']}")
```

</details>

---

### validate_mandate

Validate a mandate for a specific action on a specific resource.

```python
validate_mandate(
    mandate_id: str,
    requested_action: str,
    requested_resource: str
) -> Dict
```

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `mandate_id` | str | Yes | The mandate to validate |
| `requested_action` | str | Yes | Action being requested |
| `requested_resource` | str | Yes | Resource being accessed |

**Returns:** Dictionary with `allowed` (bool), `denial_reason` (str, if denied).

<details>
<summary>Example</summary>

```python
def execute_api_call(mandate_id: str, endpoint: str):
    validation = client.validate_mandate(
        mandate_id=mandate_id,
        requested_action="read",
        requested_resource=f"api:external/{endpoint}"
    )

    if not validation["allowed"]:
        raise PermissionError(
            f"Authority denied: {validation['denial_reason']}"
        )

    # Authority validated -- proceed
    return make_api_call(endpoint)
```

</details>

---

### register_principal

Register a new principal in the system.

```python
register_principal(
    name: str,
    principal_type: str,
    metadata: Optional[Dict] = None
) -> Dict
```

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `name` | str | Yes | Human-readable name |
| `principal_type` | str | Yes | agent, user, or service |
| `metadata` | Dict | No | Additional context |

<details>
<summary>Example</summary>

```python
principal = client.register_principal(
    name="my-ai-agent",
    principal_type="agent",
    metadata={
        "description": "Main AI agent",
        "environment": "production"
    }
)

print(f"Principal registered: {principal['principal_id']}")
```

</details>

---

### create_policy

Create an authority policy for a principal.

```python
create_policy(
    principal_id: str,
    allowed_resource_patterns: List[str],
    allowed_actions: List[str],
    max_validity_seconds: int = 86400,
    delegation_depth: int = 0
) -> Dict
```

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `principal_id` | str | Yes | Target principal |
| `allowed_resource_patterns` | List[str] | Yes | Resource patterns (wildcards supported) |
| `allowed_actions` | List[str] | Yes | Permitted actions |
| `max_validity_seconds` | int | No | Maximum mandate validity |
| `delegation_depth` | int | No | Maximum delegation depth |

<details>
<summary>Example</summary>

```python
policy = client.create_policy(
    principal_id="<principal-id>",
    allowed_resource_patterns=[
        "api:external/*",
        "db:read-only/*"
    ],
    allowed_actions=["read", "write", "execute"],
    max_validity_seconds=86400,
    delegation_depth=2
)
```

</details>

---

## Fail-Closed Semantics

The SDK implements fail-closed behavior. If authority cannot be verified, actions are denied.

| Scenario | Behavior |
|----------|----------|
| Initialization failure | Raises `ConnectionError` |
| Mandate validation failure | Returns `{"allowed": false}` |
| Missing policy | Returns `{"allowed": false}` |
| Any unexpected error | Deny / raise exception |

---

## Error Handling

<details>
<summary>Error handling example</summary>

```python
from caracal.sdk import AuthorityClient

try:
    client = AuthorityClient()
except ConnectionError as e:
    print(f"Connection error: {e}")

try:
    validation = client.validate_mandate(
        mandate_id="mandate-uuid",
        requested_action="read",
        requested_resource="api:external/data"
    )
    if not validation["allowed"]:
        print(f"Denied: {validation['denial_reason']}")
except Exception as e:
    print(f"Authority check failed: {e}")
```

</details>

---

## Integration Examples

<details>
<summary>OpenAI integration</summary>

```python
from caracal.sdk import AuthorityClient

client = AuthorityClient()

def chat_with_authority(messages, mandate_id: str):
    # Validate authority before calling external API
    validation = client.validate_mandate(
        mandate_id=mandate_id,
        requested_action="execute",
        requested_resource="api:openai/chat"
    )

    if not validation["allowed"]:
        raise PermissionError(
            f"Authority denied: {validation['denial_reason']}"
        )

    import openai
    response = openai.ChatCompletion.create(
        model="gpt-4",
        messages=messages
    )

    return response.choices[0].message.content
```

</details>

<details>
<summary>LangChain integration</summary>

```python
from langchain.callbacks.base import BaseCallbackHandler
from caracal.sdk import AuthorityClient

class CaracalAuthorityCallback(BaseCallbackHandler):
    def __init__(self, mandate_id: str):
        self.client = AuthorityClient()
        self.mandate_id = mandate_id

    def on_llm_start(self, serialized, prompts, **kwargs):
        validation = self.client.validate_mandate(
            mandate_id=self.mandate_id,
            requested_action="execute",
            requested_resource="api:openai/chat"
        )
        if not validation["allowed"]:
            raise PermissionError(
                f"Authority denied: {validation['denial_reason']}"
            )
```

</details>

---

## See Also

- [MCP Integration](/caracalCore/apiReference/mcpIntegration) -- Model Context Protocol
- [CLI Reference](/caracalCore/cliReference/) -- Command-line tools
