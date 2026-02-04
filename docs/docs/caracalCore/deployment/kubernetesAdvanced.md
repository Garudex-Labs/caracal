---
sidebar_position: 3
title: Kubernetes Advanced
---

# Kubernetes Advanced Configuration

This guide covers advanced Kubernetes deployment configurations for Caracal Core.

## Architecture

The deployment consists of:

- **PostgreSQL StatefulSet**: Persistent database with 10Gi storage
- **Gateway Proxy Deployment**: 3 replicas with LoadBalancer service
- **MCP Adapter Deployment**: 2 replicas with ClusterIP service
- **ConfigMap**: Non-sensitive configuration
- **Secrets**: Database credentials and TLS certificates

## Prerequisites

1. Kubernetes Cluster (v1.20+)
2. kubectl configured to access your cluster
3. TLS Certificates for Gateway Proxy HTTPS and mTLS
4. Storage Class for PostgreSQL persistent volumes

## TLS Certificate Setup

### Self-Signed (Development)

```bash
mkdir -p certs

# Server certificate
openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt \
  -days 365 -nodes -subj "/CN=caracal-gateway"

# CA certificate for mTLS
openssl req -x509 -newkey rsa:4096 -keyout certs/ca.key -out certs/ca.crt \
  -days 365 -nodes -subj "/CN=caracal-ca"

# JWT keys
ssh-keygen -t rsa -b 4096 -m PEM -f certs/jwt_private.pem -N ""
openssl rsa -in certs/jwt_private.pem -pubout -out certs/jwt_public.pem
```

### Create Kubernetes Secret

```bash
kubectl create secret generic caracal-tls \
  --from-file=server.crt=certs/server.crt \
  --from-file=server.key=certs/server.key \
  --from-file=ca.crt=certs/ca.crt \
  --from-file=jwt_public.pem=certs/jwt_public.pem \
  --namespace=caracal
```

## Resource Configuration

### Gateway Proxy

```yaml
resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    cpu: 2000m
    memory: 1Gi
```

### MCP Adapter

```yaml
resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    cpu: 2000m
    memory: 1Gi
```

### PostgreSQL

```yaml
resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: 2000m
    memory: 2Gi
```

## Scaling

```bash
# Scale Gateway to 5 replicas
kubectl scale deployment caracal-gateway -n caracal --replicas=5

# Scale MCP Adapter to 3 replicas
kubectl scale deployment caracal-mcp-adapter -n caracal --replicas=3
```

## Monitoring

### Prometheus Metrics

Pods are annotated for automatic Prometheus scraping:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "9090"
  prometheus.io/path: "/metrics"
```

### Logs

```bash
kubectl logs -n caracal -l app.kubernetes.io/component=gateway -f
kubectl logs -n caracal -l app.kubernetes.io/component=mcp-adapter -f
kubectl logs -n caracal -l app.kubernetes.io/component=database -f
```

## Database Management

### Initialize Schema

```bash
kubectl port-forward -n caracal svc/caracal-postgres 5432:5432 &

export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=caracal
export DB_USER=caracal
export DB_PASSWORD=<your-password>

caracal db init
caracal db migrate up
```

### Backup and Restore

```bash
# Backup
kubectl exec -n caracal caracal-postgres-0 -- \
  pg_dump -U caracal caracal > caracal-backup.sql

# Restore
kubectl exec -i -n caracal caracal-postgres-0 -- \
  psql -U caracal caracal < caracal-backup.sql
```

## Security

### Network Policies

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

### Pod Security

Pods are configured with security best practices:
- Run as non-root user (UID 1000)
- Drop all capabilities
- No privilege escalation
- Read-only root filesystem (where possible)

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

```yaml
spec:
  type: NodePort
  ports:
    - name: https
      port: 8443
      targetPort: 8443
      nodePort: 30443
```

## Cleanup

```bash
kubectl delete namespace caracal
```

**Warning**: This deletes all data including the database.

## Production Considerations

1. **High Availability**: Use PostgreSQL replication, deploy across multiple AZs
2. **Backup**: Implement automated database backups
3. **Monitoring**: Set up Prometheus and Grafana
4. **Security**: Use production TLS certificates, implement network policies
5. **Performance**: Tune connection pools, use horizontal pod autoscaling
