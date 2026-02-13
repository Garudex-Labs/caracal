---
sidebar_position: 4
title: Using Caracal Enterprise
---

# Using Caracal Enterprise

End-to-end guide for operating Caracal Enterprise: from setting up your workspace to enforcing authority across distributed AI agent deployments.

---

## Workflow Overview

```
+-----------------------------------------------------------------+
|                  Enterprise Dashboard                           |
|                                                                 |
|  1. Create Workspace                                            |
|  2. Register Principals (AI agents, users, services)            |
|  3. Define Authority Policies                                   |
|  4. Deploy Caracal Gateway with Enterprise Sync                 |
|  5. Agents request + validate mandates through Gateway/SDK      |
|  6. Monitor authority events in Analytics dashboard             |
+-----------------------------------------------------------------+
```

---

## Step 1: Create a Workspace

A workspace scopes all resources (principals, policies, mandates) to a team or project.

| Field | Description |
|-------|-------------|
| Name | Human-readable workspace name |
| Slug | URL-safe identifier |
| Description | Purpose of the workspace |

After creation, all operations are scoped to this workspace.

---

## Step 2: Register Principals

Register every entity that participates in the authority system.

| Principal Type | Use Case |
|----------------|----------|
| **Agent** | An AI agent that makes external API calls |
| **User** | A human who manages or oversees agents |
| **Service** | A backend service that needs authority validation |

### Via SDK

```python
from caracal.enterprise.sdk import EnterpriseClient

client = EnterpriseClient(
    base_url="https://enterprise.caracal.example.com",
    api_key="your-enterprise-api-key"
)

principal = client.register_principal(
    name="my-agent",
    principal_type="agent",
    workspace_slug="my-team",
    metadata={"environment": "production"}
)
```

### Via Dashboard

Navigate to **Principals** and select **Register New Principal**. Fill in the required fields and submit.

---

## Step 3: Define Authority Policies

Policies govern what mandates can be issued to a principal.

| Policy Field | Description |
|--------------|-------------|
| Principal | Target principal |
| Allowed Resources | Resource patterns (supports wildcards: `api:external/*`) |
| Allowed Actions | Permitted actions (read, write, execute) |
| Max Validity | Maximum mandate duration in seconds |
| Delegation Depth | How many levels of delegation are permitted |

### Via SDK

```python
policy = client.create_policy(
    principal_id=principal["principal_id"],
    allowed_resources=["api:external/*", "db:analytics/*"],
    allowed_actions=["read", "execute"],
    max_validity_seconds=86400,
    delegation_depth=2
)
```

### Via Dashboard

Navigate to **Policies**, select the target principal, and define the rules.

---

## Step 4: Deploy Gateway with Enterprise Sync

The Caracal Gateway enforces mandates at the network level. Enterprise Sync keeps it in alignment with the Enterprise control plane.

### Docker Compose

```yaml
services:
  gateway:
    image: caracal-gateway:latest
    environment:
      ENTERPRISE_URL: https://enterprise.caracal.example.com
      ENTERPRISE_API_KEY: your-key
      ENTERPRISE_WORKSPACE: my-team
      ENTERPRISE_SYNC_INTERVAL: 30
```

### Verify Sync

```bash
# Check sync status
curl http://localhost:8443/health | jq '.enterprise_sync'

# Expected output:
# {
#   "connected": true,
#   "last_sync": "2024-01-15T10:30:00Z",
#   "policies_synced": 12
# }
```

---

## Step 5: Agents Use Mandates

Once policies are defined and the Gateway is deployed, agents request mandates before performing actions.

### Request and Validate

```python
from caracal.sdk import AuthorityClient

client = AuthorityClient(
    base_url="https://gateway.example.com",
    api_key="agent-api-key"
)

# Request a mandate
mandate = client.request_mandate(
    issuer_id="<issuer-principal-id>",
    subject_id="<agent-principal-id>",
    resource_scope=["api:external/openai"],
    action_scope=["execute"],
    validity_seconds=3600
)

# Validate before execution
validation = client.validate_mandate(
    mandate_id=mandate["mandate_id"],
    requested_action="execute",
    requested_resource="api:external/openai"
)

if validation["allowed"]:
    result = call_openai()
```

### Through Gateway

Alternatively, agents route requests through the Gateway, which validates mandates transparently:

```bash
curl -X POST https://gateway.example.com/api/proxy \
  -H "Authorization: Bearer <jwt-token>" \
  -H "X-Caracal-Mandate: <mandate-id>" \
  -H "X-Caracal-Target-URL: https://api.openai.com/v1/chat/completions" \
  -d '{"model": "gpt-4", "messages": [...]}'
```

---

## Step 6: Monitor and Audit

The Enterprise Dashboard provides real-time visibility into authority events.

| Dashboard View | Description |
|----------------|-------------|
| **Live Feed** | Real-time stream of authority events (issued, validated, denied) |
| **Analytics** | Aggregated views of mandate usage and policy compliance |
| **Audit Log** | Searchable, filterable log of all authority events |
| **Alerts** | Configure notifications for anomalous patterns |

### Export Audit Data

```python
events = client.query_events(
    workspace_slug="my-team",
    event_type="denied",
    start_date="2024-01-01",
    format="json"
)
```

---

## Common Workflows

### Onboarding a New Agent

1. Register the principal (Dashboard or SDK)
2. Create an authority policy
3. Issue initial mandate
4. Verify the agent can call external APIs through the Gateway

### Revoking Authority

```python
client.revoke_mandate(mandate_id="<mandate-id>")
```

All subsequent validation requests for this mandate will return `denied`.

### Delegating Authority

```python
delegation = client.delegate_authority(
    parent_mandate_id="<parent-mandate-id>",
    child_principal_id="<child-principal-id>",
    resource_scope=["api:external/subset"],
    action_scope=["read"],
    validity_seconds=1800
)
```

The child principal receives a scoped mandate that cannot exceed the parent's authority.

---

## Enterprise SDK vs Core SDK

| Feature | Core SDK | Enterprise SDK |
|---------|----------|----------------|
| Authority validation | Yes | Yes |
| Mandate management | Yes | Yes |
| Multi-workspace support | No | Yes |
| Centralized policy management | No | Yes |
| Analytics and reporting | No | Yes |
| RBAC and SSO | No | Yes |

---

## Troubleshooting

<details>
<summary>Enterprise Sync not connecting</summary>

```bash
# Check connectivity
curl https://enterprise.caracal.example.com/health

# Verify API key
curl -H "Authorization: Bearer <key>" \
  https://enterprise.caracal.example.com/api/v1/workspaces

# Check Gateway logs
docker-compose logs -f gateway | grep "enterprise_sync"
```

</details>

<details>
<summary>Principal not syncing</summary>

- Verify the principal is registered in the correct workspace
- Check that the Gateway's `ENTERPRISE_WORKSPACE` matches the workspace slug
- Force a sync: `POST http://localhost:8443/admin/sync`

</details>

---

## Contact

- **Enterprise Sales:** [Book a Call](https://cal.com/rawx18/caracal-enterprise-sales)
- **Open Source Support:** [Book a Call](https://cal.com/rawx18/open-source)
