---
sidebar_position: 2
title: Kubernetes Deployment
---

# Kubernetes Deployment

This guide covers deploying Caracal Core to a Kubernetes cluster.

## Prerequisites

- Kubernetes cluster (v1.20+)
- `kubectl` configured to access your cluster
- `openssl` for generating TLS certificates

## Quick Deploy (Automated)

The fastest way to deploy:

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
kubectl get pods -n caracal
kubectl get svc -n caracal
kubectl logs -n caracal -l app.kubernetes.io/component=gateway --tail=50
```

## Initialize Database

```bash
# Port-forward to PostgreSQL
kubectl port-forward -n caracal svc/caracal-postgres 5432:5432 &

# Set environment variables
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=caracal
export DB_USER=caracal
export DB_PASSWORD=<your-password>

# Initialize database
caracal db init
caracal db migrate up
```

## Access the Gateway

```bash
kubectl get svc caracal-gateway -n caracal

GATEWAY_IP=$(kubectl get svc caracal-gateway -n caracal -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -k https://$GATEWAY_IP:8443/health
```

## Configuration

### Update Database Password

```bash
NEW_PASSWORD=$(openssl rand -base64 32)
echo -n "$NEW_PASSWORD" | base64

# Update secret.yaml with the base64 value, then:
kubectl apply -f secret.yaml
kubectl rollout restart deployment -n caracal
```

### Configure MCP Servers

Edit `configmap.yaml`:

```yaml
data:
  MCP_SERVERS: "local:http://mcp-server:3000,remote:http://external-mcp:3001"
```

```bash
kubectl apply -f configmap.yaml
kubectl rollout restart deployment caracal-mcp-adapter -n caracal
```

### Adjust Replicas

```bash
kubectl scale deployment caracal-gateway -n caracal --replicas=5
kubectl scale deployment caracal-mcp-adapter -n caracal --replicas=3
```

## Optional Components

### Enable Autoscaling

```bash
kubectl apply -f hpa.yaml
```

### Enable Ingress

Edit `ingress.yaml` and update the hostname, then:

```bash
kubectl apply -f ingress.yaml
```

### Enable Pod Disruption Budgets

```bash
kubectl apply -f pdb.yaml
```

### Enable Prometheus Monitoring

```bash
kubectl apply -f servicemonitor.yaml
```

## Troubleshooting

### Pods Not Starting

```bash
kubectl get pods -n caracal
kubectl describe pod <pod-name> -n caracal
kubectl logs <pod-name> -n caracal
```

### Database Connection Issues

```bash
kubectl exec -n caracal caracal-postgres-0 -- pg_isready -U caracal
kubectl logs -n caracal caracal-postgres-0
```

### LoadBalancer Not Getting IP

Use NodePort instead:

```bash
# Edit gateway-deployment.yaml to use NodePort
kubectl apply -f gateway-deployment.yaml
kubectl get svc caracal-gateway -n caracal
```

## Cleanup

```bash
kubectl delete namespace caracal
```

**Warning**: This deletes all data including the database.

## Production Checklist

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

## Next Steps

- [Kubernetes Advanced](./kubernetesAdvanced) - Advanced configuration
- [Production Guide](./production) - Production settings
- [Operational Runbook](./operationalRunbook) - Operations procedures
