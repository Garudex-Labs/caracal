# Principal & Policy Management

Manage the identities (Principals) and rules (Policies) that govern your authority system.

## Principals

A **Principal** is any entity that can hold or validate a mandate.

-   **Agents**: Automated services or AI agents.
-   **Users**: Human operators.
-   **Services**: Backend microservices.

### Creating a Principal

```bash
caracal principal create --name "payment-service" --type service
```

## Policies

A **Policy** defines what mandates can be issued to a Principal. It is the constitution of your authority system.

### Policy Structure

A policy consists of:
-   **Resource Patterns**: Wildcard patterns for allowed resources (e.g., `api:finance/*`).
-   **Actions**: List of allowed actions (e.g., `read`, `write`, `execute`).
-   **Constraints**: Limits on mandate validity, delegation depth, etc.

### creating a Policy

```bash
caracal policy create \
  --principal-id <principal-id> \
  --resources "api:*" "db:read-only/*" \
  --actions "read" "write" \
  --max-validity 86400
```

### Using the SDK

```python
# Create an authority policy
policy = client.create_policy(
    principal_id="<your-principal-id>",
    allowed_resource_patterns=[
        "api:external/*",
        "db:read-only/*"
    ],
    allowed_actions=["read", "write", "execute"],
    max_validity_seconds=86400,  # 24 hours max
    delegation_depth=2,  # Allow 2 levels of delegation
)
```

## Best Practices

-   **Least Privilege**: Grant only the minimum necessary permissions.
-   **Specific Resources**: Avoid broad wildcards like `*` in production.
-   **Short Validity**: Keep mandate validity short (e.g., 1 hour) to minimize risk.
