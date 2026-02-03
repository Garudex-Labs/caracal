# Caracal Core v0.3 - Deployment Guide

This guide covers deploying Caracal Core v0.3 in various environments, from development to production.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Docker Compose Deployment](#docker-compose-deployment)
5. [Kubernetes Deployment](#kubernetes-deployment)
6. [Helm Chart Deployment](#helm-chart-deployment)
7. [Production Considerations](#production-considerations)
8. [Scaling Strategies](#scaling-strategies)
9. [Monitoring and Observability](#monitoring-and-observability)
10. [Backup and Recovery](#backup-and-recovery)
11. [Troubleshooting](#troubleshooting)

## Overview

Caracal Core v0.3 introduces an event-driven architecture with the following components:

- **PostgreSQL**: Persistent storage for agents, policies, ledger, Merkle roots, and audit logs
- **Redis**: Real-time spending cache and metrics aggregation
- **Kafka**: Event streaming platform for scalable event processing
- **Zookeeper**: Coordination service for Kafka
- **Schema Registry**: Avro schema management for Kafka events
- **Gateway Proxy**: Network-enforced policy enforcement
- **MCP Adapter**: Model Context Protocol integration
- **LedgerWriter Consumer**: Processes metering events and writes to ledger
- **MetricsAggregator Consumer**: Updates real-time metrics in Redis
- **AuditLogger Consumer**: Writes all events to append-only audit log

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         AI Agents                                │
└───────────────┬─────────────────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────────────────────┐
│                      Gateway Proxy                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ Auth         │  │ Policy       │  │ Allowlist    │           │
│  │ (JWT/mTLS)   │  │ Evaluator    │  │ Checker      │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
└───────────────┬───────────────────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────────────────────┐
│                      Kafka Event Stream                            │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ Topics: metering.events, policy.decisions, agent.lifecycle   ││
│  └──────────────────────────────────────────────────────────────┘│
└───────────┬───────────────┬───────────────┬───────────────────────┘
            │               │               │
            ▼               ▼               ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ LedgerWriter  │  │ Metrics       │  │ AuditLogger   │
│ Consumer      │  │ Aggregator    │  │ Consumer      │
│               │  │ Consumer      │  │               │
└───────┬───────┘  └───────┬───────┘  └───────┬───────┘
        │                  │                  │
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ PostgreSQL    │  │ Redis Cache   │  │ PostgreSQL    │
│ (Ledger +     │  │ (Metrics)     │  │ (Audit Logs)  │
│  Merkle)      │  │               │  │               │
└───────────────┘  └───────────────┘  └───────────────┘
```

## Prerequisites

### All Deployments

- Docker 20.10+ and Docker Compose 2.0+ (for Docker Compose deployment)
- Kubernetes 1.20+ (for Kubernetes/Helm deployment)
- kubectl configured to access your cluster
- Helm 3.0+ (for Helm deployment)

### TLS Certificates

Generate TLS certificates for the Gateway Proxy:

```bash
mkdir -p certs

# Server certificate for HTTPS
openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt \
  -days 365 -nodes -subj "/CN=caracal-gateway"

# CA certificate for mTLS
openssl req -x509 -newkey rsa:4096 -keyout certs/ca.key -out certs/ca.crt \
  -days 365 -nodes -subj "/CN=caracal-ca"

# JWT keys
ssh-keygen -t rsa -b 4096 -m PEM -f certs/jwt_private.pem -N ""
openssl rsa -in certs/jwt_private.pem -pubout -out certs/jwt_public.pem
```

### Merkle Signing Keys

Generate ECDSA P-256 key pair for Merkle tree signing:

```bash
mkdir -p keys
openssl ecparam -name prime256v1 -genkey -noout -out keys/merkle_signing_key.pem
```

## Docker Compose Deployment

Docker Compose is ideal for development and testing environments.

### 1. Prepare Environment

```bash
# Clone repository
git clone https://github.com/caracal/caracal-core.git
cd caracal-core/Caracal

# Copy environment file
cp .env.v03.example .env

# Update passwords in .env
nano .env
```

### 2. Start Services

```bash
# Start all services
docker-compose -f docker-compose.v03.yml up -d

# View logs
docker-compose -f docker-compose.v03.yml logs -f

# Check status
docker-compose -f docker-compose.v03.yml ps
```

### 3. Initialize Database

```bash
# Wait for PostgreSQL to be ready
docker-compose -f docker-compose.v03.yml exec postgres pg_isready -U caracal

# Run migrations
docker-compose -f docker-compose.v03.yml exec cli caracal db init
docker-compose -f docker-compose.v03.yml exec cli caracal db migrate up
```

### 4. Create Kafka Topics

```bash
# Create topics
docker-compose -f docker-compose.v03.yml exec cli caracal kafka create-topics

# Verify topics
docker-compose -f docker-compose.v03.yml exec kafka kafka-topics --bootstrap-server localhost:9092 --list
```

### 5. Verify Deployment

```bash
# Check Gateway health
curl -k https://localhost:8443/health

# Check consumer logs
docker-compose -f docker-compose.v03.yml logs ledger-writer
docker-compose -f docker-compose.v03.yml logs metrics-aggregator
docker-compose -f docker-compose.v03.yml logs audit-logger
```

### 6. Stop Services

```bash
# Stop all services
docker-compose -f docker-compose.v03.yml down

# Stop and remove volumes (WARNING: deletes all data)
docker-compose -f docker-compose.v03.yml down -v
```

## Kubernetes Deployment

Kubernetes deployment is recommended for production environments.

### 1. Prepare Namespace and Secrets

```bash
# Create namespace
kubectl create namespace caracal

# Create TLS secret
kubectl create secret generic caracal-tls \
  --from-file=server.crt=certs/server.crt \
  --from-file=server.key=certs/server.key \
  --from-file=ca.crt=certs/ca.crt \
  --from-file=jwt_public.pem=certs/jwt_public.pem \
  --namespace=caracal

# Create Merkle keys secret
kubectl create secret generic caracal-merkle-keys \
  --from-file=merkle_signing_key.pem=keys/merkle_signing_key.pem \
  --namespace=caracal
```

### 2. Update ConfigMap and Secrets

```bash
cd k8s/v03

# Update passwords in secret.yaml
nano secret.yaml

# Apply ConfigMap and Secrets
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml
```

### 3. Deploy Infrastructure

```bash
# Deploy Zookeeper
kubectl apply -f zookeeper-statefulset.yaml
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=zookeeper -n caracal --timeout=300s

# Deploy Kafka
kubectl apply -f kafka-statefulset.yaml
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=kafka -n caracal --timeout=300s

# Deploy Schema Registry
kubectl apply -f schema-registry-deployment.yaml
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=schema-registry -n caracal --timeout=300s

# Deploy PostgreSQL
kubectl apply -f ../postgres-statefulset.yaml
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=database -n caracal --timeout=300s

# Deploy Redis
kubectl apply -f redis-statefulset.yaml
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=redis -n caracal --timeout=300s
```

### 4. Deploy Caracal Services

```bash
# Deploy Gateway and MCP Adapter
kubectl apply -f ../gateway-deployment.yaml
kubectl apply -f ../mcp-adapter-deployment.yaml

# Deploy Consumers
kubectl apply -f ledger-writer-deployment.yaml
kubectl apply -f metrics-aggregator-deployment.yaml
kubectl apply -f audit-logger-deployment.yaml
```

### 5. Initialize Database and Topics

```bash
# Port-forward to PostgreSQL
kubectl port-forward -n caracal svc/caracal-postgres 5432:5432 &

# Run migrations
export DB_HOST=localhost
export DB_PASSWORD=<your-password>
caracal db init
caracal db migrate up

# Port-forward to Kafka
kubectl port-forward -n caracal caracal-kafka-0 9092:9092 &

# Create topics
caracal kafka create-topics
```

### 6. Verify Deployment

```bash
# Check all pods
kubectl get pods -n caracal

# Check services
kubectl get svc -n caracal

# View logs
kubectl logs -n caracal -l app.kubernetes.io/name=caracal -f
```

## Helm Chart Deployment

Helm provides the easiest way to deploy and manage Caracal Core.

### 1. Prepare Secrets

```bash
# Create namespace
kubectl create namespace caracal

# Create TLS secret
kubectl create secret generic caracal-tls \
  --from-file=server.crt=certs/server.crt \
  --from-file=server.key=certs/server.key \
  --from-file=ca.crt=certs/ca.crt \
  --from-file=jwt_public.pem=certs/jwt_public.pem \
  --namespace=caracal

# Create Merkle keys secret
kubectl create secret generic caracal-merkle-keys \
  --from-file=merkle_signing_key.pem=keys/merkle_signing_key.pem \
  --namespace=caracal
```

### 2. Create Values File

Create `my-values.yaml`:

```yaml
postgresql:
  auth:
    password: "YOUR_SECURE_PASSWORD"

redis:
  auth:
    password: "YOUR_SECURE_PASSWORD"

gateway:
  service:
    type: LoadBalancer
  tls:
    secretName: caracal-tls
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 10

consumers:
  ledgerWriter:
    merkle:
      signingKeySecretName: caracal-merkle-keys
```

### 3. Install Chart

```bash
# Install from local chart
helm install caracal ./helm/caracal-v03 -n caracal -f my-values.yaml

# Or from repository (if published)
helm repo add caracal https://charts.caracal.dev
helm install caracal caracal/caracal -n caracal -f my-values.yaml
```

### 4. Initialize Database and Topics

```bash
# Port-forward to PostgreSQL
kubectl port-forward -n caracal svc/caracal-postgres 5432:5432 &

# Run migrations
caracal db init
caracal db migrate up

# Port-forward to Kafka
kubectl port-forward -n caracal caracal-kafka-0 9092:9092 &

# Create topics
caracal kafka create-topics
```

### 5. Verify Installation

```bash
# Check status
helm status caracal -n caracal

# Check pods
kubectl get pods -n caracal

# View logs
kubectl logs -n caracal -l app.kubernetes.io/name=caracal -f
```

### 6. Upgrade

```bash
# Upgrade with new values
helm upgrade caracal caracal/caracal -n caracal -f my-values.yaml

# Rollback if needed
helm rollback caracal -n caracal
```

## Production Considerations

### 1. Use Managed Services

For production, consider using managed services:

**Kafka**:
- Confluent Cloud
- AWS MSK (Managed Streaming for Apache Kafka)
- Azure Event Hubs
- Google Cloud Pub/Sub

**Redis**:
- AWS ElastiCache for Redis
- Azure Cache for Redis
- Google Cloud Memorystore

**PostgreSQL**:
- AWS RDS for PostgreSQL
- Azure Database for PostgreSQL
- Google Cloud SQL for PostgreSQL
- CloudNativePG operator

### 2. Security Hardening

```yaml
# Enable Kafka SASL/SSL
kafka:
  security:
    protocol: SASL_SSL
    saslMechanism: SCRAM-SHA-512

# Enable Redis TLS
redis:
  tls:
    enabled: true

# Enable network policies
networkPolicy:
  enabled: true

# Use production TLS certificates
gateway:
  tls:
    secretName: production-tls-cert
```

### 3. High Availability

```yaml
# Multiple replicas
gateway:
  replicaCount: 5
  autoscaling:
    enabled: true
    minReplicas: 5
    maxReplicas: 20

# Pod disruption budgets
gateway:
  podDisruptionBudget:
    enabled: true
    minAvailable: 3

# Multi-zone deployment
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: topology.kubernetes.io/zone
```

### 4. Resource Limits

Adjust based on workload:

```yaml
gateway:
  resources:
    requests:
      cpu: 1000m
      memory: 1Gi
    limits:
      cpu: 4000m
      memory: 4Gi

kafka:
  resources:
    requests:
      cpu: 2000m
      memory: 4Gi
    limits:
      cpu: 8000m
      memory: 16Gi
```

## Scaling Strategies

### Horizontal Scaling

**Gateway Proxy**:
- Scale based on request rate
- Target: 70% CPU utilization
- Min replicas: 3, Max replicas: 20

**Kafka Consumers**:
- Scale based on consumer lag
- One consumer per partition for maximum parallelism
- Monitor lag with Prometheus

**Kafka Brokers**:
- Add brokers for increased throughput
- Rebalance partitions after adding brokers

### Vertical Scaling

**PostgreSQL**:
- Increase CPU/memory for query performance
- Use read replicas for read-heavy workloads

**Redis**:
- Increase memory for larger cache
- Use Redis Cluster for horizontal scaling

**Kafka**:
- Increase memory for larger page cache
- Increase disk for longer retention

### Partition Scaling

**Kafka Topics**:
```bash
# Increase partitions for metering.events
kafka-topics --bootstrap-server localhost:9092 \
  --alter --topic caracal.metering.events \
  --partitions 20
```

**PostgreSQL**:
- Use table partitioning by month
- Archive old partitions to cold storage

## Monitoring and Observability

### Prometheus Metrics

Metrics exposed on:
- Gateway: `:9090/metrics`
- MetricsAggregator: `:9091/metrics`

Key metrics:
- `caracal_requests_total`: Total requests
- `caracal_request_duration_seconds`: Request latency
- `caracal_policy_evaluations_total`: Policy evaluations
- `caracal_kafka_consumer_lag`: Consumer lag
- `caracal_merkle_batch_size`: Merkle batch size
- `caracal_spending_total`: Total spending per agent

### Grafana Dashboards

Import dashboards from `monitoring/grafana/`:
- Gateway metrics
- Kafka consumer metrics
- Merkle tree operations
- Spending trends

### Logging

Structured JSON logging to stdout:

```json
{
  "timestamp": "2026-02-03T10:15:30Z",
  "level": "INFO",
  "component": "gateway",
  "message": "Request processed",
  "agent_id": "agent-123",
  "request_id": "req-456",
  "duration_ms": 45
}
```

Aggregate logs with:
- ELK Stack (Elasticsearch, Logstash, Kibana)
- Loki + Grafana
- CloudWatch Logs (AWS)
- Azure Monitor (Azure)

### Alerting

Configure alerts for:
- Kafka consumer lag > 10000
- DLQ size > 1000
- Merkle verification failures
- Database connection failures
- High error rates (> 5%)
- High latency (p99 > 1s)

## Backup and Recovery

### PostgreSQL Backup

```bash
# Manual backup
kubectl exec -n caracal caracal-postgres-0 -- \
  pg_dump -U caracal caracal > caracal-backup-$(date +%Y%m%d).sql

# Automated backup with CronJob
kubectl apply -f k8s/backup-cronjob.yaml

# Restore from backup
kubectl exec -i -n caracal caracal-postgres-0 -- \
  psql -U caracal caracal < caracal-backup-20260203.sql
```

### Kafka Backup

```bash
# Backup Kafka topics
kafka-mirror-maker --consumer.config consumer.properties \
  --producer.config producer.properties \
  --whitelist "caracal.*"

# Or use Confluent Replicator
```

### Snapshot-Based Recovery

```bash
# Create snapshot
caracal snapshot create

# List snapshots
caracal snapshot list

# Restore from snapshot
caracal snapshot restore --snapshot-id <id>
```

### Event Replay

```bash
# Replay events from timestamp
caracal replay start --from-timestamp 2026-02-03T00:00:00Z

# Replay from snapshot
caracal replay start --from-snapshot <snapshot-id>

# Check replay status
caracal replay status
```

## Troubleshooting

### Gateway Not Starting

```bash
# Check logs
kubectl logs -n caracal -l app.kubernetes.io/component=gateway

# Check database connectivity
kubectl exec -n caracal caracal-postgres-0 -- pg_isready

# Check Redis connectivity
kubectl exec -n caracal caracal-redis-0 -- redis-cli ping
```

### Kafka Consumer Lag

```bash
# Check consumer lag
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --describe --group ledger-writer-group

# Reset consumer offset
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --group ledger-writer-group --reset-offsets \
  --to-earliest --topic caracal.metering.events --execute
```

### Merkle Verification Failures

```bash
# Verify specific batch
caracal merkle verify-batch --batch-id <id>

# Verify time range
caracal merkle verify-range --start 2026-02-01 --end 2026-02-03

# Check Merkle signer logs
kubectl logs -n caracal -l app.kubernetes.io/component=ledger-writer | grep merkle
```

### Database Performance Issues

```bash
# Check slow queries
kubectl exec -n caracal caracal-postgres-0 -- \
  psql -U caracal -c "SELECT * FROM pg_stat_statements ORDER BY total_time DESC LIMIT 10;"

# Check connection pool
kubectl exec -n caracal caracal-postgres-0 -- \
  psql -U caracal -c "SELECT * FROM pg_stat_activity;"

# Vacuum and analyze
kubectl exec -n caracal caracal-postgres-0 -- \
  psql -U caracal -c "VACUUM ANALYZE;"
```

## Support

For issues and questions:

- GitHub Issues: https://github.com/caracal/caracal-core/issues
- Documentation: https://caracal.dev/docs
- Community: https://caracal.dev/community
- Email: support@caracal.dev
