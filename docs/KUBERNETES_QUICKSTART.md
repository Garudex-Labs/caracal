# Caracal Core v0.2 - Kubernetes Quickstart Guide

This guide will help you deploy Caracal Core v0.2 to a Kubernetes cluster in minutes.

## Prerequisites

- Kubernetes cluster (v1.20+)
- `kubectl` configured to access your cluster
- `openssl` for generating TLS certificates (optional)

## Quick Deploy (Automated)

The fastest way to deploy Caracal Core:

```bash
cd k8s
./deploy.sh --wait
```

This script will:
1. Create the `caracal` namespace
2. Generate self-signed TLS certificates (for testing)
3. Deploy PostgreSQL with persistent storage
4. Deploy Gateway Proxy (3 replicas)
5. Deploy MCP Adapter (2 replicas)
6. Wait for all components to be ready

## Manual Deploy

If you prefer manual deployment:

### 1. Create TLS Certificates

```bash
mkdir -p k8s/certs
cd k8s/certs

# Server certificate for Gateway HTTPS
openssl req -x509 -newkey rsa:4096 -keyout server.key -out server.crt \
  -days 365 -nodes -subj "/CN=caracal-gateway"

# CA certificate for mTLS
openssl req -x509 -newkey rsa:4096 -keyout ca.key -out ca.crt \
  -days 365 -nodes -subj "/CN=caracal-ca"

# JWT keys
ssh-keygen -t rsa -b 4096 -m PEM -f jwt_private.pem -N ""
openssl rsa -in jwt_private.pem -pubout -out jwt_public.pem

cd ..
```

### 2. Deploy to Kubernetes

```bash
# Create namespace
kubectl apply -f namespace.yaml

# Create ConfigMap and Secrets
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml

# Create TLS secret from files
kubectl create secret generic caracal-tls \
  --from-file=server.crt=certs/server.crt \
  --from-file=server.key=certs/server.key \
  --from-file=ca.crt=certs/ca.crt \
  --from-file=jwt_public.pem=certs/jwt_public.pem \
  --namespace=caracal

# Deploy PostgreSQL
kubectl apply -f postgres-statefulset.yaml

# Wait for PostgreSQL
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=database \
  -n caracal --timeout=300s

# Deploy Gateway Proxy
kubectl apply -f gateway-deployment.yaml

# Deploy MCP Adapter
kubectl apply -f mcp-adapter-deployment.yaml
```

### 3. Verify Deployment

```bash
# Check all pods are running
kubectl get pods -n caracal

# Check services
kubectl get svc -n caracal

# View logs
kubectl logs -n caracal -l app.kubernetes.io/component=gateway --tail=50
```

## Initialize Database

After deployment, initialize the database schema:

```bash
# Port-forward to PostgreSQL
kubectl port-forward -n caracal svc/caracal-postgres 5432:5432 &

# Set environment variables
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=caracal
export DB_USER=caracal
export DB_PASSWORD=caracal_dev_password  # Use your actual password

# Initialize database
caracal db init
caracal db migrate up
```

## Access the Gateway

Get the Gateway LoadBalancer IP:

```bash
kubectl get svc caracal-gateway -n caracal

# Test health endpoint
GATEWAY_IP=$(kubectl get svc caracal-gateway -n caracal -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -k https://$GATEWAY_IP:8443/health
```

## Configuration

### Update Database Password

Edit `secret.yaml` and change the `DB_PASSWORD`:

```bash
# Generate secure password
NEW_PASSWORD=$(openssl rand -base64 32)

# Encode in base64
echo -n "$NEW_PASSWORD" | base64

# Update secret.yaml with the base64 value
# Then apply:
kubectl apply -f secret.yaml

# Restart pods to pick up new password
kubectl rollout restart deployment -n caracal
```

### Configure MCP Servers

Edit `configmap.yaml` and set `MCP_SERVERS`:

```yaml
data:
  MCP_SERVERS: "local:http://mcp-server:3000,remote:http://external-mcp:3001"
```

Apply changes:

```bash
kubectl apply -f configmap.yaml
kubectl rollout restart deployment caracal-mcp-adapter -n caracal
```

### Adjust Replicas

Scale deployments as needed:

```bash
# Scale Gateway to 5 replicas
kubectl scale deployment caracal-gateway -n caracal --replicas=5

# Scale MCP Adapter to 3 replicas
kubectl scale deployment caracal-mcp-adapter -n caracal --replicas=3
```

## Optional Components

### Enable Autoscaling

```bash
kubectl apply -f hpa.yaml
```

This enables automatic scaling based on CPU/memory usage:
- Gateway: 3-10 replicas
- MCP Adapter: 2-8 replicas

### Enable Ingress

Edit `ingress.yaml` and update the hostname:

```yaml
spec:
  tls:
    - hosts:
        - caracal-gateway.your-domain.com
```

Apply:

```bash
kubectl apply -f ingress.yaml
```

### Enable Pod Disruption Budgets

```bash
kubectl apply -f pdb.yaml
```

This ensures minimum availability during cluster maintenance.

### Enable Prometheus Monitoring

If using Prometheus Operator:

```bash
kubectl apply -f servicemonitor.yaml
```

## Troubleshooting

### Pods Not Starting

```bash
# Check pod status
kubectl get pods -n caracal

# Describe pod
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

# Test connection
kubectl run -it --rm psql --image=postgres:14-alpine --restart=Never \
  -- psql -h caracal-postgres.caracal.svc.cluster.local -U caracal -d caracal
```

### LoadBalancer Not Getting IP

If your cluster doesn't support LoadBalancer, use NodePort:

```bash
# Edit gateway-deployment.yaml
# Change service type from LoadBalancer to NodePort
kubectl apply -f gateway-deployment.yaml

# Get NodePort
kubectl get svc caracal-gateway -n caracal
```

Or use Ingress (see above).

## Cleanup

Remove all Caracal resources:

```bash
# Delete all resources
kubectl delete namespace caracal
```

**Warning**: This deletes all data including the database.

## Production Checklist

Before deploying to production:

- [ ] Use production TLS certificates (not self-signed)
- [ ] Change default database password
- [ ] Configure proper storage class for PostgreSQL
- [ ] Set up database backups
- [ ] Configure resource limits based on load testing
- [ ] Enable monitoring (Prometheus, Grafana)
- [ ] Set up alerting for critical metrics
- [ ] Configure network policies
- [ ] Enable pod security policies
- [ ] Test disaster recovery procedures
- [ ] Document runbooks for common operations

## Next Steps

- Read the full [Kubernetes README](k8s/README.md)
- Configure [monitoring and alerting](k8s/README.md#monitoring)
- Set up [database backups](k8s/README.md#backup-database)
- Review [security best practices](k8s/README.md#security)

## Support

- Documentation: https://caracal.dev/docs
- GitHub Issues: https://github.com/caracal/caracal-core/issues
- Community: https://caracal.dev/community
