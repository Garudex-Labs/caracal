# Caracal Core - Helm Chart

This Helm chart deploys Caracal Core on a Kubernetes cluster.

## Prerequisites

- Kubernetes 1.20+
- Helm 3.0+
- PV provisioner support in the underlying infrastructure (for persistent volumes)
- TLS certificates
- Merkle signing keys for cryptographic ledger

## Installing the Chart

### 1. Add Helm Repository (if published)

```bash
helm repo add caracal https://charts.garudexlabs.com
helm repo update
```

### 2. Prepare Secrets

Create TLS certificates:

```bash
# Generate self-signed certificates (for testing)
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt \
  -days 365 -nodes -subj "/CN=caracal"
openssl req -x509 -newkey rsa:4096 -keyout certs/ca.key -out certs/ca.crt \
  -days 365 -nodes -subj "/CN=caracal-ca"
ssh-keygen -t rsa -b 4096 -m PEM -f certs/jwt_private.pem -N ""
openssl rsa -in certs/jwt_private.pem -pubout -out certs/jwt_public.pem

# Create TLS secret
kubectl create namespace caracal
kubectl create secret generic caracal-tls \
  --from-file=server.crt=certs/server.crt \
  --from-file=server.key=certs/server.key \
  --from-file=ca.crt=certs/ca.crt \
  --from-file=jwt_public.pem=certs/jwt_public.pem \
  --namespace=caracal
```

Generate Merkle signing keys:

```bash
# Generate ECDSA P-256 key pair
mkdir -p keys
openssl ecparam -name prime256v1 -genkey -noout -out keys/merkle_signing_key.pem

# Create Merkle keys secret
kubectl create secret generic caracal-merkle-keys \
  --from-file=merkle_signing_key.pem=keys/merkle_signing_key.pem \
  --namespace=caracal
```

### 3. Create values file

Create a `my-values.yaml` file with your custom configuration:

```yaml
# Update passwords
postgresql:
  auth:
    password: "YOUR_SECURE_PASSWORD_HERE"

redis:
  auth:
    password: "YOUR_SECURE_PASSWORD_HERE"

# Configure consumers
consumers:
  ledgerWriter:
    merkle:
      signingKeySecretName: caracal-merkle-keys

mcpAdapter:
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 8
```

### 4. Install the chart

```bash
# Install with default values
helm install caracal caracal/caracal -n caracal --create-namespace

# Install with custom values
helm install caracal caracal/caracal -n caracal --create-namespace -f my-values.yaml

# Install from local chart
helm install caracal ./helm/caracal -n caracal --create-namespace -f my-values.yaml
```

### 5. Verify installation

```bash
# Check pod status
kubectl get pods -n caracal -w

# Check services
kubectl get svc -n caracal

# Check StatefulSets
kubectl get statefulsets -n caracal

# View logs
kubectl logs -n caracal -l app.kubernetes.io/name=caracal -f
```

### 6. Initialize database

```bash
# Port-forward to PostgreSQL
kubectl port-forward -n caracal svc/caracal-postgres 5432:5432 &

# Run migrations
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=caracal
export DB_USER=caracal
export DB_PASSWORD=<your-password>

caracal db init
caracal db migrate up
```

## Uninstalling the Chart

```bash
# Uninstall the release
helm uninstall caracal -n caracal

# Delete the namespace (WARNING: deletes all data)
kubectl delete namespace caracal
```

## Configuration

The following table lists the configurable parameters of the Caracal chart and their default values.

### Global Parameters

| Parameter                 | Description                          | Default   |
| ------------------------- | ------------------------------------ | --------- |
| `global.namespace`        | Namespace to deploy into             | `caracal` |
| `global.imagePullSecrets` | Image pull secrets                   | `[]`      |
| `global.storageClass`     | Storage class for persistent volumes | `""`      |

### PostgreSQL Parameters

| Parameter                              | Description            | Default                          |
| -------------------------------------- | ---------------------- | -------------------------------- |
| `postgresql.enabled`                   | Enable PostgreSQL      | `true`                           |
| `postgresql.auth.database`             | Database name          | `caracal`                        |
| `postgresql.auth.username`             | Database username      | `caracal`                        |
| `postgresql.auth.password`             | Database password      | `caracal_dev_password_CHANGE_ME` |
| `postgresql.persistence.size`          | Persistent volume size | `10Gi`                           |
| `postgresql.resources.requests.cpu`    | CPU request            | `500m`                           |
| `postgresql.resources.requests.memory` | Memory request         | `512Mi`                          |
| `postgresql.resources.limits.cpu`      | CPU limit              | `2000m`                          |
| `postgresql.resources.limits.memory`   | Memory limit           | `2Gi`                            |

### Redis Parameters

| Parameter                         | Description            | Default                            |
| --------------------------------- | ---------------------- | ---------------------------------- |
| `redis.enabled`                   | Enable Redis           | `true`                             |
| `redis.auth.password`             | Redis password         | `caracal_redis_password_CHANGE_ME` |
| `redis.persistence.size`          | Persistent volume size | `10Gi`                             |
| `redis.resources.requests.cpu`    | CPU request            | `250m`                             |
| `redis.resources.requests.memory` | Memory request         | `256Mi`                            |
| `redis.resources.limits.cpu`      | CPU limit              | `1000m`                            |
| `redis.resources.limits.memory`   | Memory limit           | `512Mi`                            |

## Upgrading

## Troubleshooting

### Pods not starting

```bash
# Check pod status
kubectl get pods -n caracal

# Describe pod for events
kubectl describe pod <pod-name> -n caracal

# Check logs
kubectl logs <pod-name> -n caracal
```

### Database connection issues

```bash
# Check PostgreSQL is ready
kubectl exec -n caracal caracal-postgres-0 -- pg_isready -U caracal

# Check database logs
kubectl logs -n caracal caracal-postgres-0

# Verify credentials
kubectl get secret caracal-secrets -n caracal -o yaml
```

## Production Recommendations

1. **Use managed services**:
   - Managed Redis (AWS ElastiCache, Azure Cache for Redis)
   - Managed PostgreSQL (AWS RDS, Azure Database for PostgreSQL)

2. **Security**:
   - Use production TLS certificates from a trusted CA
   - Enable network policies
   - Rotate passwords regularly
   - Enable audit logging

3. **High Availability**:
   - Deploy across multiple availability zones
   - Use pod disruption budgets
   - Enable autoscaling
   - Configure resource limits appropriately

4. **Monitoring**:
   - Enable Prometheus ServiceMonitors
   - Set up Grafana dashboards
   - Configure alerts for critical metrics

5. **Backup and Recovery**:
   - Implement automated database backups
   - Test restore procedures regularly
   - Use volume snapshots
   - Document recovery procedures

## Support

For issues and questions:

- GitHub Issues: https://github.com/caracal/caracal-core/issues
- Documentation: https://garudexlabs.com/docs
- Community: https://garudexlabs.com/community
