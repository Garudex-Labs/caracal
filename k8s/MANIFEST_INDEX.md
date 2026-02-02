# Caracal Core v0.2 - Kubernetes Manifest Index

This document provides an index of all Kubernetes manifests and their purposes.

## Core Manifests (Required)

### 1. namespace.yaml
- **Purpose**: Creates the `caracal` namespace for all resources
- **Resources**: 1 Namespace
- **Dependencies**: None
- **Deploy Order**: 1

### 2. configmap.yaml
- **Purpose**: Non-sensitive configuration for all services
- **Resources**: 1 ConfigMap
- **Contains**:
  - Database connection settings
  - Gateway configuration
  - MCP adapter configuration
  - Authentication settings
  - Cache settings
  - Provisional charge settings
- **Dependencies**: namespace.yaml
- **Deploy Order**: 2

### 3. secret.yaml
- **Purpose**: Sensitive configuration (passwords, certificates)
- **Resources**: 2 Secrets
  - `caracal-secrets`: Database password
  - `caracal-tls`: TLS certificates (template)
- **Security**: Base64 encoded, should be encrypted at rest
- **Dependencies**: namespace.yaml
- **Deploy Order**: 2
- **Note**: Update with actual credentials before deploying

### 4. postgres-statefulset.yaml
- **Purpose**: PostgreSQL database with persistent storage
- **Resources**:
  - 1 StatefulSet (1 replica)
  - 1 Headless Service
  - 1 PersistentVolumeClaim (10Gi)
- **Ports**: 5432 (PostgreSQL)
- **Probes**: Liveness and Readiness
- **Dependencies**: namespace.yaml, configmap.yaml, secret.yaml
- **Deploy Order**: 3

### 5. gateway-deployment.yaml
- **Purpose**: Gateway Proxy for network-enforced policy enforcement
- **Resources**:
  - 1 Deployment (3 replicas)
  - 2 Services (LoadBalancer and ClusterIP for metrics)
- **Ports**:
  - 8443 (HTTPS gateway)
  - 9090 (Prometheus metrics)
- **Probes**: Liveness, Readiness, and Startup
- **Features**:
  - TLS/mTLS support
  - JWT authentication
  - Replay protection
  - Policy caching
  - Pod anti-affinity
- **Dependencies**: postgres-statefulset.yaml, secret.yaml (TLS)
- **Deploy Order**: 4

### 6. mcp-adapter-deployment.yaml
- **Purpose**: MCP Adapter for Model Context Protocol integration
- **Resources**:
  - 1 Deployment (2 replicas)
  - 1 Service (ClusterIP)
- **Ports**: 8080 (HTTP)
- **Probes**: Liveness, Readiness, and Startup
- **Features**:
  - MCP tool interception
  - Budget enforcement
  - Cost calculation
  - Pod anti-affinity
- **Dependencies**: postgres-statefulset.yaml
- **Deploy Order**: 5

## Optional Manifests (Recommended)

### 7. hpa.yaml
- **Purpose**: Horizontal Pod Autoscaler for automatic scaling
- **Resources**: 2 HorizontalPodAutoscalers
  - Gateway: 3-10 replicas (70% CPU, 80% memory)
  - MCP Adapter: 2-8 replicas (70% CPU, 80% memory)
- **Requirements**: metrics-server installed
- **Benefits**: Automatic scaling based on load

### 8. pdb.yaml
- **Purpose**: Pod Disruption Budgets for high availability
- **Resources**: 2 PodDisruptionBudgets
  - Gateway: minAvailable=2
  - MCP Adapter: minAvailable=1
- **Benefits**: Ensures minimum availability during voluntary disruptions

### 9. ingress.yaml
- **Purpose**: Ingress for external access (alternative to LoadBalancer)
- **Resources**: 2 Ingresses + 1 Secret
  - Gateway Ingress (HTTPS)
  - Metrics Ingress (HTTP with basic auth)
  - Basic auth secret for metrics
- **Requirements**: Ingress controller (nginx, traefik, etc.)
- **Benefits**: Single entry point, SSL termination, path-based routing

### 10. servicemonitor.yaml
- **Purpose**: Prometheus Operator integration
- **Resources**: 2 ServiceMonitors
  - Gateway metrics scraping
  - MCP Adapter metrics scraping
- **Requirements**: Prometheus Operator installed
- **Benefits**: Automatic Prometheus configuration

## Deployment Helpers

### 11. kustomization.yaml
- **Purpose**: Kustomize configuration for simplified deployment
- **Usage**: `kubectl apply -k .`
- **Features**:
  - Common labels
  - Image management
  - Replica configuration
  - Namespace management

### 12. deploy.sh
- **Purpose**: Automated deployment script
- **Usage**: `./deploy.sh [options]`
- **Features**:
  - Automatic TLS certificate generation
  - Sequential deployment
  - Wait for readiness
  - Dry-run mode
  - Status checking

## Deployment Order

For manual deployment, follow this order:

1. **namespace.yaml** - Create namespace
2. **configmap.yaml** - Create configuration
3. **secret.yaml** - Create secrets (update first!)
4. Create TLS secret from files (if not using secret.yaml)
5. **postgres-statefulset.yaml** - Deploy database
6. Wait for PostgreSQL to be ready
7. **gateway-deployment.yaml** - Deploy Gateway Proxy
8. **mcp-adapter-deployment.yaml** - Deploy MCP Adapter
9. **hpa.yaml** (optional) - Enable autoscaling
10. **pdb.yaml** (optional) - Enable disruption budgets
11. **ingress.yaml** (optional) - Configure ingress
12. **servicemonitor.yaml** (optional) - Enable Prometheus

## Quick Reference

### Deploy Everything
```bash
./deploy.sh --wait
```

### Deploy with Kustomize
```bash
kubectl apply -k .
```

### Deploy Manually
```bash
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml
kubectl apply -f postgres-statefulset.yaml
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=database -n caracal --timeout=300s
kubectl apply -f gateway-deployment.yaml
kubectl apply -f mcp-adapter-deployment.yaml
```

### Deploy Optional Components
```bash
kubectl apply -f hpa.yaml
kubectl apply -f pdb.yaml
kubectl apply -f ingress.yaml
kubectl apply -f servicemonitor.yaml
```

### Check Status
```bash
kubectl get all -n caracal
kubectl get pods -n caracal -w
kubectl logs -n caracal -l app.kubernetes.io/name=caracal -f
```

### Cleanup
```bash
kubectl delete namespace caracal
```

## Resource Summary

| Component | Replicas | CPU Request | Memory Request | CPU Limit | Memory Limit |
|-----------|----------|-------------|----------------|-----------|--------------|
| PostgreSQL | 1 | 500m | 512Mi | 2000m | 2Gi |
| Gateway | 3 | 250m | 256Mi | 2000m | 1Gi |
| MCP Adapter | 2 | 250m | 256Mi | 2000m | 1Gi |
| **Total** | **6** | **1500m** | **1536Mi** | **10000m** | **8Gi** |

## Port Summary

| Service | Port | Protocol | Purpose |
|---------|------|----------|---------|
| PostgreSQL | 5432 | TCP | Database |
| Gateway | 8443 | HTTPS | Gateway proxy |
| Gateway | 9090 | HTTP | Prometheus metrics |
| MCP Adapter | 8080 | HTTP | MCP API |

## Storage Summary

| Component | Volume | Size | Access Mode |
|-----------|--------|------|-------------|
| PostgreSQL | postgres-data | 10Gi | ReadWriteOnce |

## Security Features

- Non-root containers (UID 1000)
- Read-only root filesystem (where possible)
- Dropped capabilities
- No privilege escalation
- TLS/mTLS support
- JWT authentication
- Replay protection
- Secret management
- Network policies (optional)

## High Availability Features

- Multiple replicas (Gateway: 3, MCP Adapter: 2)
- Pod anti-affinity (spread across nodes)
- Liveness and readiness probes
- Rolling updates
- Pod disruption budgets
- Horizontal pod autoscaling
- LoadBalancer service

## Monitoring Features

- Prometheus metrics endpoints
- ServiceMonitor for Prometheus Operator
- Health check endpoints
- Structured JSON logging
- Request tracing with correlation IDs

## Requirements Met

This Kubernetes deployment satisfies the following requirements from the design document:

- **Requirement 17.2**: Gateway Proxy deployment as Kubernetes Service with configurable replicas ✓
- **Requirement 17.4**: Health check endpoints for liveness and readiness probes ✓
- **Deployment**: 3 replicas for Gateway Proxy ✓
- **Service**: LoadBalancer for Gateway Proxy ✓
- **ConfigMap**: Configuration management ✓
- **Secret**: TLS certificates and credentials ✓
- **Probes**: Liveness and readiness probes ✓
