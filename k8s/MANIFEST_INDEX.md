# Caracal Core - Kubernetes Manifest Index

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

### 5. mcp-adapter-deployment.yaml

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
- **Resources**: 1 HorizontalPodAutoscalers
  - MCP Adapter: 2-8 replicas (70% CPU, 80% memory)
- **Requirements**: metrics-server installed
- **Benefits**: Automatic scaling based on load

### 8. pdb.yaml

- **Purpose**: Pod Disruption Budgets for high availability
- **Resources**: 1 PodDisruptionBudgets
  - MCP Adapter: minAvailable=1
- **Benefits**: Ensures minimum availability during voluntary disruptions

### 9. servicemonitor.yaml

- **Purpose**: Prometheus Operator integration
- **Resources**: 1 ServiceMonitors
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
7. **mcp-adapter-deployment.yaml** - Deploy MCP Adapter
8. **hpa.yaml** (optional) - Enable autoscaling
9. **pdb.yaml** (optional) - Enable disruption budgets
10. **servicemonitor.yaml** (optional) - Enable Prometheus

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
kubectl apply -f mcp-adapter-deployment.yaml
```

### Deploy Optional Components

```bash
kubectl apply -f hpa.yaml
kubectl apply -f pdb.yaml
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

| Component   | Replicas | CPU Request | Memory Request | CPU Limit | Memory Limit |
| ----------- | -------- | ----------- | -------------- | --------- | ------------ |
| PostgreSQL  | 1        | 500m        | 512Mi          | 2000m     | 2Gi          |
| MCP Adapter | 2        | 250m        | 256Mi          | 2000m     | 1Gi          |
| **Total**   | **3**    | **750m**    | **768Mi**      | **4000m** | **3Gi**      |

## Port Summary

| Service     | Port | Protocol | Purpose  |
| ----------- | ---- | -------- | -------- |
| PostgreSQL  | 5432 | TCP      | Database |
| MCP Adapter | 8080 | HTTP     | MCP API  |

## Storage Summary

| Component  | Volume        | Size | Access Mode   |
| ---------- | ------------- | ---- | ------------- |
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

- Multiple replicas (MCP Adapter: 2)
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

- **ConfigMap**: Configuration management ✓
- **Secret**: TLS certificates and credentials ✓
- **Probes**: Liveness and readiness probes ✓
