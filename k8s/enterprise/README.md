# Caracal Core - Kubernetes Deployment

This directory contains Kubernetes manifests for deploying Caracal Core in a Kubernetes cluster.

## Architecture

The deployment consists of:

- **PostgreSQL StatefulSet**: Persistent database with 10Gi storage
- **Redis StatefulSet**: Cache for real-time metrics and spending (10Gi storage)
- **Gateway Proxy Deployment**: 3 replicas with LoadBalancer service
- **MCP Adapter Deployment**: 2 replicas with ClusterIP service
- **LedgerWriter Consumer Deployment**: 2 replicas for event processing
- **MetricsAggregator Consumer Deployment**: 2 replicas for metrics aggregation
- **AuditLogger Consumer Deployment**: 2 replicas for audit logging
- **ConfigMap**: Non-sensitive configuration
- **Secrets**: Database credentials, Redis password, Merkle signing keys, TLS certificates

## Prerequisites

1. **Kubernetes Cluster**: v1.20 or later
2. **kubectl**: Configured to access your cluster
3. **Storage Class**: For persistent volumes (optional)
4. **TLS Certificates**: For Gateway Proxy HTTPS and mTLS
5. **Merkle Signing Keys**: For cryptographic ledger signing

## Quick Start

### 1. Create Namespace

```bash
kubectl create namespace caracal
```

### 2. Prepare TLS Certificates

Create TLS certificates for the Gateway Proxy (same as core edition):

```bash
mkdir -p certs

# Generate self-signed certificates (for testing only)
openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt \
  -days 365 -nodes -subj "/CN=caracal-gateway"

openssl req -x509 -newkey rsa:4096 -keyout certs/ca.key -out certs/ca.crt \
  -days 365 -nodes -subj "/CN=caracal-ca"

ssh-keygen -t rsa -b 4096 -m PEM -f certs/jwt_private.pem -N ""
openssl rsa -in certs/jwt_private.pem -pubout -out certs/jwt_public.pem

# Create TLS secret
kubectl create secret generic caracal-tls \
  --from-file=server.crt=certs/server.crt \
  --from-file=server.key=certs/server.key \
  --from-file=ca.crt=certs/ca.crt \
  --from-file=jwt_public.pem=certs/jwt_public.pem \
  --namespace=caracal
```

### 3. Generate Merkle Signing Keys

```bash
mkdir -p keys

# Generate ECDSA P-256 key pair for Merkle signing
openssl ecparam -name prime256v1 -genkey -noout -out keys/merkle_signing_key.pem

# Create Merkle keys secret
kubectl create secret generic caracal-merkle-keys \
  --from-file=merkle_signing_key.pem=keys/merkle_signing_key.pem \
  --namespace=caracal
```

### 4. Update Secrets

Edit `secret.yaml` and update passwords:

```bash
# Generate secure passwords
DB_PASSWORD=$(openssl rand -base64 32)
REDIS_PASSWORD=$(openssl rand -base64 32)

# Encode in base64
echo -n "$DB_PASSWORD" | base64
echo -n "$REDIS_PASSWORD" | base64

# Update the values in secret.yaml
```

### 5. Deploy Infrastructure

Deploy in order:

```bash
# Create ConfigMap and Secrets
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml

# Deploy PostgreSQL
kubectl apply -f ../postgres-statefulset.yaml

# Wait for PostgreSQL to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=database -n caracal --timeout=300s

# Deploy Redis
kubectl apply -f redis-statefulset.yaml

# Wait for Redis to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=redis -n caracal --timeout=300s
```

### 6. Deploy Caracal Services

```bash
# Deploy Gateway Proxy (updated for v0.3)
kubectl apply -f ../gateway-deployment.yaml

# Deploy MCP Adapter (updated for v0.3)
kubectl apply -f ../mcp-adapter-deployment.yaml


```

### 7. Verify Deployment

```bash
# Check all pods are running
kubectl get pods -n caracal

# Check services
kubectl get svc -n caracal

# Check StatefulSets
kubectl get statefulsets -n caracal

# Check Gateway Proxy logs
kubectl logs -n caracal -l app.kubernetes.io/component=gateway --tail=50


```

### 8. Initialize Database Schema

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

## Scaling

### Horizontal Scaling

Scale deployments as needed:

```bash
# Scale Gateway Proxy
kubectl scale deployment caracal-gateway -n caracal --replicas=5

# Scale MCP Adapter
kubectl scale deployment caracal-mcp-adapter -n caracal --replicas=3


```

### Vertical Scaling

Adjust resource limits in deployment files based on workload.

## Monitoring

### Prometheus Metrics

Metrics are exposed on:

- **Gateway Proxy**: `http://<gateway-pod>:9090/metrics`
- **MCP Adapter**: `http://<mcp-adapter-pod>:8080/metrics`


### Health Checks

Health endpoints:

- **Gateway Proxy**: `https://<gateway-ip>:8443/health`
- **MCP Adapter**: `http://<mcp-adapter-ip>:8080/health`
- **PostgreSQL**: `pg_isready` command
- **Redis**: `redis-cli ping`


### Logs

View logs:

```bash
# All Caracal logs
kubectl logs -n caracal -l app.kubernetes.io/name=caracal -f --all-containers

# Gateway logs
kubectl logs -n caracal -l app.kubernetes.io/component=gateway -f


```

## Troubleshooting

### Redis Connection Issues

```bash
# Check Redis is ready
kubectl exec -n caracal caracal-redis-0 -- redis-cli ping

# Test Redis authentication
kubectl exec -n caracal caracal-redis-0 -- \
  redis-cli -a $(kubectl get secret caracal-secrets -n caracal -o jsonpath='{.data.REDIS_PASSWORD}' | base64 -d) ping
```

## Cleanup

Remove all Caracal resources:

```bash
# Delete deployments
kubectl delete -f ledger-writer-deployment.yaml
kubectl delete -f metrics-aggregator-deployment.yaml
kubectl delete -f ../gateway-deployment.yaml
kubectl delete -f ../mcp-adapter-deployment.yaml

# Delete StatefulSets
kubectl delete -f redis-statefulset.yaml
kubectl delete -f ../postgres-statefulset.yaml

# Delete ConfigMap and Secrets
kubectl delete -f secret.yaml
kubectl delete -f configmap.yaml

# Or delete the entire namespace
kubectl delete namespace caracal
```

**Warning**: This will delete all data including databases.

## Production Considerations

1. **High Availability**:
   - Use managed Redis (AWS ElastiCache, Azure Cache for Redis)
   - Use PostgreSQL replication (Patroni, Stolon, CloudNativePG)
   - Deploy across multiple availability zones

2. **Security**:
   - Enable Redis TLS
   - Use production TLS certificates
   - Implement network policies
   - Enable audit logging

3. **Monitoring**:
   - Set up Prometheus and Grafana
   - Configure alerts for critical metrics
   - Monitor Merkle batch processing
   - Monitor DLQ size

4. **Backup and Recovery**:
   - Implement automated database backups
   - Test restore procedures regularly
   - Use volume snapshots

5. **Performance**:
   - Adjust resource limits based on load
   - Use horizontal pod autoscaling
   - Monitor and optimize query performance

## Support

For issues and questions:

- GitHub Issues: https://github.com/caracal/caracal-core/issues
- Documentation: https://garudexlabs.com/docs
- Community: https://garudexlabs.com/community
