<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Caracal

Caracal provides cross-harness AI component management, distribution, and observability for developer teams. This chart deploys the API server, web UI, PostgreSQL, ClickHouse, Redis, and supporting Kubernetes resources for self-hosted installations.

## Install

After the hosted OCI chart has been published:

```bash
kubectl create namespace caracal
helm install caracal oci://ghcr.io/garudex-labs/charts/caracal \
  --version <version> \
  --namespace caracal
```

For production deployments, use managed PostgreSQL, ClickHouse, and Redis services by setting `postgresql.enabled=false`, `clickhouse.enabled=false`, and `redis.enabled=false`, then providing the matching external connection URLs.

See the Kubernetes deployment guide for the full values reference and operational notes:

https://github.com/Garudex-Labs/caracal/blob/main/docs/self-hosting/kubernetes-helm.md
