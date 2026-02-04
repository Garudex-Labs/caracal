---
sidebar_position: 10
title: FAQ
---

# Frequently Asked Questions

Common questions and answers about Caracal.

## General

### What is Caracal?

Caracal is a network-enforced policy enforcement and metering system for AI agents. It ensures agents operate within defined economic boundaries and provides cryptographic proof of all spending events.

### What problems does Caracal solve?

- **Runaway Spending**: Prevents agents from making unlimited API calls
- **Policy Violations**: Ensures agents only access authorized resources
- **Unaccountable Actions**: Provides a complete audit trail for all agent behavior

### Is Caracal open source?

Yes, Caracal is open source and available on [GitHub](https://github.com/Garudex-Labs/Caracal).

## Architecture

### What is the Gateway Proxy?

The Gateway Proxy is the core component that intercepts all agent HTTP/HTTPS traffic, performs authentication, evaluates policies, and emits metering events.

### What is fail-closed semantics?

Fail-closed means that if the policy engine or ledger is unavailable, requests are denied by default. This prevents unchecked spending during outages.

### What database does Caracal use?

Caracal uses PostgreSQL for the ledger and policy storage, and Redis for real-time metrics caching.

## Deployment

### What are the minimum requirements?

- Docker 20.10+ and Docker Compose 1.29+
- At least 4GB RAM
- PostgreSQL 14+
- TLS certificates for the gateway

### Can I run Caracal locally for development?

Yes, use Docker Compose for local development:

```bash
docker-compose up -d
```

### Does Caracal support Kubernetes?

Yes, Caracal includes Kubernetes manifests and Helm charts for production deployments. See the [Kubernetes Deployment](./caracalCore/deployment/kubernetes) guide.

## SDK

### What languages are supported?

Currently, Caracal provides a Python SDK. Other language SDKs are planned.

### How do I install the SDK?

```bash
pip install caracal-sdk
```

### What happens if the Caracal server is unavailable?

The SDK uses fail-closed semantics. If the server is unavailable, all requests are denied by default.

## Policies

### What types of policies can I create?

- **Spending Limits**: Maximum amount per time window (daily, weekly, monthly)
- **Time Windows**: Calendar-based or rolling windows
- **Allowlists**: Restrict which APIs or models an agent can use

### Can policies be changed at runtime?

Yes, policies can be updated at any time via the SDK, CLI, or Caracal Flow TUI.

### How are policies evaluated?

Policies are evaluated synchronously before each request is proxied. If any policy is violated, the request is denied.

## Security

### How is data integrity ensured?

All metering events are recorded in a Merkle tree-backed ledger. Each batch is signed with ECDSA, providing cryptographic proof of integrity.

### What authentication methods are supported?

- mTLS (mutual TLS)
- JWT (JSON Web Tokens)
- API Keys

### Is data encrypted at rest?

We recommend enabling encryption at rest for PostgreSQL and Redis in production deployments.

## Troubleshooting

### Why are my requests being denied?

Common causes:
1. Policy limit exceeded
2. Agent not registered
3. Authentication failure
4. Server unavailable (fail-closed)

Check the gateway logs for detailed error messages.

### How do I check the current spending?

```bash
caracal ledger query --agent-id <agent-id>
```

### How do I verify ledger integrity?

```bash
caracal merkle verify-range --start <date> --end <date>
```

## Support

### Where can I get help?

- [GitHub Issues](https://github.com/Garudex-Labs/Caracal/issues)
- [Discord Community](https://discord.gg/caracal)
- Email: support@caracal.dev
