<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Kubernetes Deployment with Helm

Deploy Caracal onto a Kubernetes cluster using the official Helm chart.

> [!WARNING]
> **Production Notice**: The in-cluster PostgreSQL, ClickHouse, and Redis StatefulSets deployed by this chart are intended for evaluation, development, and small-scale testing. For production workloads, set `postgresql.enabled=false`, `clickhouse.enabled=false`, and `redis.enabled=false`, then provide `postgresql.externalUrl`, `clickhouse.externalUrl`, and `redis.externalUrl` for managed services such as AWS RDS, Cloud SQL, ClickHouse Cloud, or ElastiCache.

## Prerequisites

- Kubernetes cluster v1.27 or higher
- `helm` v3.8.0 or higher installed
- `kubectl` configured to access your cluster
- Ingress controller (e.g., `ingress-nginx`) installed on the cluster
- Default `StorageClass` supporting dynamic volume provisioning (PV/PVC)

## Quick Start

Use the hosted OCI chart after the first release that includes Helm chart publishing has completed:

1. Install the chart into a dedicated namespace:
   ```bash
   kubectl create namespace caracal
   helm install caracal oci://ghcr.io/garudex-labs/charts/caracal \
     --version <version> \
     --namespace caracal
   ```

2. Verify all workloads are running and completed:
   ```bash
   kubectl get pods -n caracal
   ```

## Local Chart Development

To test unreleased chart changes directly from a clone:

1. Clone the repository:
   ```bash
   git clone https://github.com/Garudex-Labs/caracal.git
   cd caracal
   ```

2. Install the chart into a dedicated namespace:
   ```bash
   kubectl create namespace caracal
   helm install caracal ./infra/helm/caracal --namespace caracal
   ```

3. Verify all workloads are running and completed:
   ```bash
   kubectl get pods -n caracal
   ```

## Configuration

You can customize the deployment by passing a custom values file (`-f values.yaml`) or setting flags via `--set`.

```bash
helm install caracal oci://ghcr.io/garudex-labs/charts/caracal \
  --version <version> \
  --namespace caracal \
  -f custom-values.yaml
```

### Parameters Reference Table

| Parameter | Description | Default |
| --- | --- | --- |
| `global.imageRegistry` | Global image registry prefix | `""` |
| `global.imagePullSecrets` | Global image pull secrets list | `[]` |
| `api.image.repository` | API server image repository | `ghcr.io/garudex-labs/caracal-server` |
| `api.image.tag` | API container image tag. Defaults to the chart app version when empty. | `""` |
| `api.replicas` | Replicas for API deployment | `1` |
| `auth.image.repository` | Identity service image repository | `ghcr.io/garudex-labs/caracal-auth` |
| `auth.image.tag` | Identity service image tag. Defaults to the chart app version when empty. | `""` |
| `auth.replicas` | Replicas for the identity service | `1` |
| `web.image.repository` | Web UI container image repository | `ghcr.io/garudex-labs/caracal-web` |
| `web.image.tag` | Web UI container image tag. Defaults to the chart app version when empty. | `""` |
| `web.replicas` | Replicas for Web UI deployment | `1` |
| `postgresql.enabled` | Deploy embedded PostgreSQL StatefulSet | `true` |
| `postgresql.externalUrl` | PostgreSQL URL used when embedded PostgreSQL is disabled | `""` |
| `postgresql.storage.size` | PVC size for PostgreSQL | `10Gi` |
| `clickhouse.enabled` | Deploy embedded ClickHouse StatefulSet | `true` |
| `clickhouse.externalUrl` | ClickHouse URL used when embedded ClickHouse is disabled | `""` |
| `clickhouse.storage.size` | PVC size for ClickHouse | `50Gi` |
| `redis.enabled` | Deploy embedded Redis StatefulSet | `true` |
| `redis.externalUrl` | Redis URL used when embedded Redis is disabled | `""` |
| `redis.storage.size` | PVC size for Redis | `2Gi` |
| `ingress.enabled` | Enable Kubernetes Ingress resource | `true` |
| `ingress.host` | Hostname for Ingress rule | `caracal.example.com` |
| `ingress.tls.enabled` | Enable TLS termination on Ingress | `false` |
| `ingress.tls.certManager.enabled` | Automatically request cert via cert-manager | `false` |
| `secrets.existingSecret` | Use pre-existing K8s Secret for credentials | `""` |
| `secrets.secretKey` | Override generated application secret | `""` |
| `config.jwtIssuer` | Public origin of the deployment: token issuer, identity base URL, and trusted browser origin | `http://localhost` |

Background jobs run inside the API server process; there is no separate worker deployment.

## Accessing the Application

### Via Port Forwarding (Development/Testing)

To access the Web UI locally without configuring Ingress DNS:

```bash
kubectl port-forward svc/caracal-web 8000:8000 -n caracal
```

Open `http://localhost:8000` in your browser.

### Via Ingress & TLS (Production)

Enable ingress and configure TLS termination using `cert-manager`:

```bash
helm upgrade --install caracal oci://ghcr.io/garudex-labs/charts/caracal \
  --version <version> \
  --namespace caracal \
  --set ingress.enabled=true \
  --set ingress.host=caracal.mycompany.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=caracal-tls \
  --set ingress.tls.certManager.enabled=true \
  --set ingress.tls.certManager.issuerName=letsencrypt-prod
```

## Maintenance & Operations

### Upgrading

To apply configuration changes or update to a newer chart version:

```bash
helm upgrade caracal oci://ghcr.io/garudex-labs/charts/caracal \
  --version <version> \
  --namespace caracal \
  -f custom-values.yaml
```

### Rollback

If an upgrade encounters issues, rollback to a previous release revision:

```bash
# View release history
helm history caracal --namespace caracal

# Rollback to revision 1
helm rollback caracal 1 --namespace caracal
```

### Uninstalling

To delete the deployment and associated Kubernetes resources:

```bash
helm uninstall caracal --namespace caracal
```

> [!NOTE]
> Persistent Volume Claims (PVCs) for PostgreSQL, ClickHouse, Redis, and API data are retained by default to prevent accidental data loss. To delete them permanently, execute: `kubectl delete pvc -l app.kubernetes.io/instance=caracal -n caracal`.

## Chart Publishing

Official releases publish the Helm chart as an OCI artifact to GitHub Container Registry:

```text
oci://ghcr.io/garudex-labs/charts/caracal
```

Helm OCI registries do not use `helm repo add`; install and upgrade commands reference the `oci://` chart URL directly.

After the first release publishes the package, make the GHCR chart package public in the repository package settings if it is not already public.

ArtifactHub should be registered against the OCI chart URL. OCI repositories require one ArtifactHub repository per chart. The release workflow pushes `infra/helm/artifacthub-repo.yml` to GHCR with the special `artifacthub.io` tag. After ArtifactHub creates the repository record, copy the repository ID from the ArtifactHub control panel into `infra/helm/artifacthub-repo.yml` as `repositoryID` to enable Verified Publisher status on the next chart release.
