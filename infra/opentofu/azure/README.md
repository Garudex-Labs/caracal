<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Caracal - Azure OpenTofu Module

Deploy Caracal to Azure using Container Apps, PostgreSQL Flexible Server, Azure Cache for Redis, and a self-hosted ClickHouse VM.

## Architecture

```
Internet
    |
    v
Azure Container Apps (VNet-integrated)
    ├── caracal-api     (Go API server, port 8080, autoscale 2-10)
    ├── caracal-auth    (identity service, port 3001, autoscale 2-4)
    ├── caracal-web     (nginx SPA, autoscale 2-6)
    └── caracal-init    (one-shot migration job: caracal-server image, args ["init"])
    |
    v (private VNet)
    ├── Azure Database for PostgreSQL Flexible Server (zone-redundant in prod)
    ├── Azure Cache for Redis (Standard tier, TLS-only)
    └── Azure VM: ClickHouse + Prometheus (Premium SSD data disk)
    |
    v
Azure Managed Grafana (connected to Log Analytics + ClickHouse)
```

Background jobs run inside the API server process; there is no separate worker.

Each Container App is served at its own FQDN. The API server validates tokens
against the identity service's URL (`/api/auth/jwks`); the web app's trusted
origin is passed to the identity service via `AUTH_TRUSTED_ORIGINS`. If you
front the apps with a gateway that terminates one shared domain, route
`/api/auth/*` to caracal-auth (3001) ahead of `/api/*` to caracal-api (8080),
and everything else to caracal-web.

## Prerequisites

- Azure CLI (`az login`)
- OpenTofu >= 1.6
- Docker (for building/pushing images to ACR)

## Quick Start

```bash
# 1. Initialize
cd infra/opentofu/azure
tofu init

# 2. Deploy staging
tofu apply -var-file=staging.tfvars

# 3. Push images to ACR (after first apply creates the registry)
ACR=$(tofu output -raw acr_login_server)
az acr login --name $ACR
docker tag ghcr.io/garudex-labs/caracal-server:latest $ACR/garudex-labs/caracal-server:latest
docker tag ghcr.io/garudex-labs/caracal-auth:latest $ACR/garudex-labs/caracal-auth:latest
docker tag ghcr.io/garudex-labs/caracal-web:latest $ACR/garudex-labs/caracal-web:latest
docker push $ACR/garudex-labs/caracal-server:latest
docker push $ACR/garudex-labs/caracal-auth:latest
docker push $ACR/garudex-labs/caracal-web:latest

# 4. Trigger the init job (migrations)
az containerapp job start -n caracal-staging-init -g caracal-staging-rg

# 5. Get URLs
tofu output api_url
tofu output auth_url
tofu output web_url
```

## Environments

| File | Description |
|------|-------------|
| `staging.tfvars` | Cost-optimized, single replicas, smaller SKUs |
| `prod.tfvars` | Zone-redundant PostgreSQL, HA Redis, autoscaling, larger VMs |

## ClickHouse Modes

Set `clickhouse_mode`:
- `"self_hosted"` (default) - Azure VM with managed disk. Cheapest option.
- `"cloud"` - ClickHouse Cloud. Supply `clickhouse_cloud_url` and `clickhouse_cloud_password`.

## Estimated Monthly Cost (Staging)

| Resource | ~Cost |
|----------|-------|
| Container Apps (3 apps, min replicas) | $30 |
| PostgreSQL Flexible (B2s) | $25 |
| Redis (Standard C0) | $15 |
| ClickHouse VM (D2s_v5) | $70 |
| Managed Grafana | $10 |
| Log Analytics | $5 |
| ACR (Basic) | $5 |
| **Total** | **~$160/mo** |

## Destroying

```bash
tofu destroy -var-file=staging.tfvars
```
