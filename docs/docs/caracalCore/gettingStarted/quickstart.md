---
sidebar_position: 2
title: Quickstart Guide
---

# Quickstart (Open Source Broker Mode)

This guide sets up Caracal Core in open-source mode where the broker executes
provider actions directly using provider definitions.

## Prerequisites

- Python 3.11+
- PostgreSQL accessible from your machine

## 1. Install and Initialize

```bash
pip install caracal-core
caracal init
```

## 2. Configure a Provider

Every provider requires a provider definition.

```bash
caracal provider add openai-main \
  --provider-definition openai \
  --credential "$OPENAI_API_KEY"
```

## 3. Register Principals

```bash
caracal principal register --name issuer --type user --owner admin@example.com
caracal principal register --name agent-a --type agent --owner admin@example.com
```

## 4. Create a Policy with Provider Scopes

Use shell completion for provider-derived scopes.

```bash
caracal policy create \
  --principal-id <issuer-principal-uuid> \
  --max-validity-seconds 3600 \
  --provider openai-main \
  --resource-pattern provider:openai-main:resource:chat.completions \
  --action provider:openai-main:action:invoke
```

## 5. Issue and Enforce a Mandate

```bash
caracal authority mandate \
  --issuer-id <issuer-principal-uuid> \
  --subject-id <agent-principal-uuid> \
  --provider openai-main \
  --resource-scope provider:openai-main:resource:chat.completions \
  --action-scope provider:openai-main:action:invoke \
  --validity-seconds 1800
```

```bash
caracal authority enforce \
  --mandate-id <mandate-uuid> \
  --provider openai-main \
  --resource provider:openai-main:resource:chat.completions \
  --action provider:openai-main:action:invoke
```

## 6. Use the TUI

```bash
caracal-flow
```

In Flow, policy, mandate, and delegation screens now use provider-based
resource/action selection only.
