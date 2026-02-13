# Setup Guide

This guide will walk you through the initial setup of Caracal Enterprise integration. You will learn how to install the SDK, configure your environment, and register your first principal.

## Prerequisites

-   A Caracal Enterprise account (or self-hosted instance).
-   Python 3.8+ installed.
-   Your API Key and Authority URL (available in the Dashboard Settings).

## Step 1: Install the SDK

Install the Caracal Core Python SDK to integrate authority enforcement into your application.

```bash
pip install caracal-core
```

Verify the installation:

```python
import caracal
print(f"Caracal SDK v{caracal.__version__} installed")

from caracal.sdk import AuthorityClient
print("AuthorityClient ready")
```

## Step 2: Configure Connection

Initialize the Caracal client to connect to your authority enforcement backend.

Set up your environment variables:

```bash
export CARACAL_AUTHORITY_URL=https://your-caracal-instance.example.com
export CARACAL_API_KEY=your-api-key-here
```

Initialize the client in your code:

```python
import os
from caracal.sdk import AuthorityClient

# Initialize client using environment variables
client = AuthorityClient(
    base_url=os.environ["CARACAL_AUTHORITY_URL"],
    api_key=os.environ.get("CARACAL_API_KEY"),
)

# Verify connection
health = client.health_check()
print(f"Connected: {health['status']}")
```

## Step 3: Register Principals

Principals are the entities (AI agents, users, or services) that hold and validate mandates. You need to register them before they can be assigned policies.

### Using CLI

```bash
caracal principal create \
  --name "my-ai-agent" \
  --type agent
```

### Using SDK

```python
# Register an AI agent principal
principal = client.register_principal(
    name="my-ai-agent",
    principal_type="agent",  # or "user", "service"
    metadata={
        "description": "Main AI agent for external API calls",
        "environment": "production"
    }
)

print(f"Principal registered: {principal['principal_id']}")
```

## Next Steps

Once you have registered your principals, you are ready to [Create Policies](../guides/principalManagement.md) and [Integrate the SDK](../guides/sdkIntegration.md) into your agent's workflow.
