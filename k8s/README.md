# Caracal Core - Kubernetes Deployment

This directory contains Kubernetes manifests for deploying Caracal Core in a Kubernetes cluster.

## Architecture

The deployment consists of:

- **PostgreSQL StatefulSet**: Persistent database with 10Gi storage
- **MCP Adapter Deployment**: 2 replicas with ClusterIP service
- **ConfigMap**: Non-sensitive configuration
- **Secrets**: Database credentials and TLS certificates

## Prerequisites

1. **Kubernetes Cluster**: v1.20 or later
2. **kubectl**: Configured to access your cluster
4. **Storage Class**: For PostgreSQL persistent volumes (optional)

## Quick Start

### 1. Prepare TLS Certificates


```bash
# Create a directory for certificates
mkdir -p certs

# Generate self-signed certificates (for testing only)
openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt \
  -days 365 -nodes -subj "/CN=caracal-gateway"

# CA certificate for mTLS client authentication
openssl req -x509 -newkey rsa:4096 -keyout certs/ca.key -out certs/ca.crt \
  -days 365 -nodes -subj "/CN=caracal-ca"

# JWT keys for JWT authentication
ssh-keygen -t rsa -b 4096 -m PEM -f certs/jwt_private.pem -N ""
openssl rsa -in certs/jwt_private.pem -pubout -out certs/jwt_public.pem
```

**Production**: Use certificates from a trusted CA (Let's Encrypt, internal PKI, etc.)

### 2. Create Kubernetes Secret for TLS

```bash
# Create TLS secret from certificate files
kubectl create secret generic caracal-tls \
  --from-file=server.crt=certs/server.crt \
  --from-file=server.key=certs/server.key \
  --from-file=ca.crt=certs/ca.crt \
  --from-file=jwt_public.pem=certs/jwt_public.pem \
  --namespace=caracal --dry-run=client -o yaml > tls-secret-generated.yaml

# Apply the secret
kubectl apply -f tls-secret-generated.yaml
```

### 3. Update Database Password

Edit `secret.yaml` and replace the default database password:

```bash
# Generate a secure password
NEW_PASSWORD=$(openssl rand -base64 32)

# Encode it in base64
echo -n "$NEW_PASSWORD" | base64

# Update the DB_PASSWORD value in secret.yaml
```

### 4. Deploy to Kubernetes

Deploy all components in order:

```bash
# Create namespace
kubectl apply -f namespace.yaml

# Create ConfigMap and Secrets
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml

# Deploy PostgreSQL
kubectl apply -f postgres-statefulset.yaml

# Wait for PostgreSQL to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=database -n caracal --timeout=300s

kubectl apply -f gateway-deployment.yaml

# Deploy MCP Adapter
kubectl apply -f mcp-adapter-deployment.yaml
```

### 5. Verify Deployment

```bash
# Check all pods are running
kubectl get pods -n caracal

# Check services
kubectl get svc -n caracal

kubectl logs -n caracal -l app.kubernetes.io/component=gateway --tail=50

# Check MCP Adapter logs
kubectl logs -n caracal -l app.kubernetes.io/component=mcp-adapter --tail=50
```


```bash
# Get the LoadBalancer external IP
kubectl get svc caracal-gateway -n caracal

# Test health endpoint
GATEWAY_IP=$(kubectl get svc caracal-gateway -n caracal -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -k https://$GATEWAY_IP:8443/health
```

## Configuration

### ConfigMap Customization

Edit `configmap.yaml` to customize:

- Database connection settings
- Authentication mode (jwt, mtls, api_key)
- Replay protection settings
- Policy cache settings
- Provisional charge timeouts
- MCP server URLs

### Resource Limits

Adjust resource requests and limits in deployment files:

```yaml
resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    cpu: 2000m
    memory: 1Gi
```

**MCP Adapter** (`mcp-adapter-deployment.yaml`):
```yaml
resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    cpu: 2000m
    memory: 1Gi
```

**PostgreSQL** (`postgres-statefulset.yaml`):
```yaml
resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: 2000m
    memory: 2Gi
```

### Scaling

Scale deployments as needed:

```bash
kubectl scale deployment caracal-gateway -n caracal --replicas=5

# Scale MCP Adapter to 3 replicas
kubectl scale deployment caracal-mcp-adapter -n caracal --replicas=3
```

### Storage Class

If your cluster uses a specific storage class, update `postgres-statefulset.yaml`:

```yaml
volumeClaimTemplates:
  - metadata:
      name: postgres-data
    spec:
      accessModes:
        - ReadWriteOnce
      storageClassName: your-storage-class  # Add this line
      resources:
        requests:
          storage: 10Gi
```

## Monitoring

### Prometheus Metrics


- **MCP Adapter**: `http://<mcp-adapter-pod>:8080/metrics`

Pods are annotated for automatic Prometheus scraping:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "9090"  # or "8080" for MCP Adapter
  prometheus.io/path: "/metrics"
```

### Health Checks

Health endpoints are available:

- **MCP Adapter**: `http://<mcp-adapter-ip>:8080/health`
- **PostgreSQL**: `pg_isready` command

### Logs

View logs for troubleshooting:

```bash
kubectl logs -n caracal -l app.kubernetes.io/component=gateway -f

# MCP Adapter logs
kubectl logs -n caracal -l app.kubernetes.io/component=mcp-adapter -f

# PostgreSQL logs
kubectl logs -n caracal -l app.kubernetes.io/component=database -f

# All Caracal logs
kubectl logs -n caracal -l app.kubernetes.io/name=caracal -f --all-containers
```

## Database Management

### Initialize Database Schema

Run database migrations after first deployment:

```bash
# Port-forward to PostgreSQL
kubectl port-forward -n caracal svc/caracal-postgres 5432:5432 &

# Run migrations (from Caracal directory)
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=caracal
export DB_USER=caracal
export DB_PASSWORD=<your-password>

caracal db init
caracal db migrate up
```

### Backup Database

```bash
# Create a backup
kubectl exec -n caracal caracal-postgres-0 -- \
  pg_dump -U caracal caracal > caracal-backup-$(date +%Y%m%d).sql

# Restore from backup
kubectl exec -i -n caracal caracal-postgres-0 -- \
  psql -U caracal caracal < caracal-backup-20260202.sql
```

### Access Database

```bash
# Port-forward to PostgreSQL
kubectl port-forward -n caracal svc/caracal-postgres 5432:5432

# Connect with psql
psql -h localhost -p 5432 -U caracal -d caracal
```

## Security

### Network Policies

Consider adding NetworkPolicies to restrict traffic:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: caracal-network-policy
  namespace: caracal
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: caracal
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              name: caracal
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              name: caracal
```

### Pod Security Standards

Pods are configured with security best practices:

- Run as non-root user (UID 1000)
- Drop all capabilities
- No privilege escalation
- Read-only root filesystem (where possible)

### RBAC

Create ServiceAccounts and RBAC policies as needed for your environment.

## Troubleshooting

### Pods Not Starting

```bash
# Check pod status
kubectl get pods -n caracal

# Describe pod for events
kubectl describe pod <pod-name> -n caracal

# Check logs
kubectl logs <pod-name> -n caracal
```

### Database Connection Issues

```bash
# Check PostgreSQL is ready
kubectl exec -n caracal caracal-postgres-0 -- pg_isready -U caracal

# Check database logs
kubectl logs -n caracal caracal-postgres-0

# Verify secret is correct
kubectl get secret caracal-secrets -n caracal -o jsonpath='{.data.DB_PASSWORD}' | base64 -d
```

### TLS Certificate Issues

```bash
# Verify TLS secret exists
kubectl get secret caracal-tls -n caracal

# Check certificate contents
kubectl get secret caracal-tls -n caracal -o jsonpath='{.data.server\.crt}' | base64 -d | openssl x509 -text -noout

# Check certificate expiration
kubectl get secret caracal-tls -n caracal -o jsonpath='{.data.server\.crt}' | base64 -d | openssl x509 -enddate -noout
```

### LoadBalancer Not Getting External IP

```bash
# Check service status
kubectl describe svc caracal-gateway -n caracal

# Check cloud provider integration
kubectl get events -n caracal --sort-by='.lastTimestamp'
```

If LoadBalancer is not supported, use NodePort or Ingress:

```yaml
# Change service type to NodePort
spec:
  type: NodePort
  ports:
    - name: https
      port: 8443
      targetPort: 8443
      nodePort: 30443  # Optional: specify port
```

## Cleanup

Remove all Caracal resources:

```bash
# Delete all resources
kubectl delete -f mcp-adapter-deployment.yaml
kubectl delete -f gateway-deployment.yaml
kubectl delete -f postgres-statefulset.yaml
kubectl delete -f secret.yaml
kubectl delete -f configmap.yaml
kubectl delete -f namespace.yaml

# Or delete the entire namespace
kubectl delete namespace caracal
```

**Warning**: This will delete all data including the PostgreSQL database.

## Production Considerations

1. **High Availability**:
   - Use PostgreSQL replication (e.g., Patroni, Stolon)
   - Deploy across multiple availability zones
   - Use pod disruption budgets

2. **Backup and Recovery**:
   - Implement automated database backups
   - Test restore procedures regularly
   - Use volume snapshots

3. **Monitoring and Alerting**:
   - Set up Prometheus and Grafana
   - Configure alerts for critical metrics
   - Monitor resource usage and scaling

4. **Security**:
   - Use production TLS certificates
   - Implement network policies
   - Enable audit logging
   - Regular security updates

5. **Performance**:
   - Tune database connection pools
   - Adjust resource limits based on load
   - Use horizontal pod autoscaling
   - Monitor and optimize query performance

## Support

For issues and questions:

- GitHub Issues: https://github.com/caracal/caracal-core/issues
- Documentation: https://garudexlabs.com/docs
- Community: https://garudexlabs.com/community
