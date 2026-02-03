# Caracal Core v0.3 - Production Deployment Guide

This guide covers production-specific considerations for deploying Caracal Core v0.3.

## Table of Contents

1. [Production Architecture](#production-architecture)
2. [Infrastructure Requirements](#infrastructure-requirements)
3. [Security Best Practices](#security-best-practices)
4. [High Availability](#high-availability)
5. [Performance Tuning](#performance-tuning)
6. [Monitoring and Alerting](#monitoring-and-alerting)
7. [Disaster Recovery](#disaster-recovery)
8. [Capacity Planning](#capacity-planning)
9. [Operational Runbook](#operational-runbook)

## Production Architecture

### Recommended Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Load Balancer (AWS ALB/NLB)                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ Gateway       │   │ Gateway       │   │ Gateway       │
│ (AZ-1)        │   │ (AZ-2)        │   │ (AZ-3)        │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              Managed Kafka (AWS MSK / Confluent Cloud)           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │ Broker (AZ-1)│  │ Broker (AZ-2)│  │ Broker (AZ-3)│         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ LedgerWriter  │   │ Metrics       │   │ AuditLogger   │
│ (2+ replicas) │   │ Aggregator    │   │ (2+ replicas) │
│               │   │ (2+ replicas) │   │               │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ RDS PostgreSQL│   │ ElastiCache   │   │ RDS PostgreSQL│
│ (Multi-AZ)    │   │ Redis         │   │ (Multi-AZ)    │
│ + Read Replica│   │ (Cluster)     │   │               │
└───────────────┘   └───────────────┘   └───────────────┘
```

### Multi-Region Architecture (Optional)

For global deployments:

```
Region 1 (Primary)          Region 2 (Secondary)
┌─────────────────┐         ┌─────────────────┐
│ Caracal Stack   │         │ Caracal Stack   │
│ (Active)        │◄───────►│ (Standby)       │
└─────────────────┘         └─────────────────┘
        │                           │
        ▼                           ▼
┌─────────────────┐         ┌─────────────────┐
│ PostgreSQL      │         │ PostgreSQL      │
│ (Primary)       │────────►│ (Replica)       │
└─────────────────┘         └─────────────────┘
```

## Infrastructure Requirements

### Minimum Production Requirements

**Kubernetes Cluster**:
- 3+ worker nodes across 3 availability zones
- Node size: 8 vCPU, 32 GB RAM minimum
- Total cluster capacity: 24+ vCPU, 96+ GB RAM

**Managed Services**:
- **Kafka**: 3+ brokers, kafka.m5.large or equivalent
- **PostgreSQL**: db.r5.xlarge or equivalent (4 vCPU, 32 GB RAM)
- **Redis**: cache.r5.large or equivalent (2 vCPU, 13 GB RAM)

**Storage**:
- PostgreSQL: 500 GB SSD (gp3), auto-scaling enabled
- Kafka: 1 TB SSD per broker
- Redis: 50 GB memory

### Recommended Production Configuration

**Gateway Proxy**:
- Replicas: 5-10 (autoscaling)
- CPU: 1000m request, 4000m limit
- Memory: 1Gi request, 4Gi limit

**Kafka Consumers**:
- LedgerWriter: 3-5 replicas
- MetricsAggregator: 3-5 replicas
- AuditLogger: 2-3 replicas
- CPU: 500m request, 2000m limit per replica
- Memory: 512Mi request, 2Gi limit per replica

**Kafka**:
- Brokers: 3-6 (depending on throughput)
- Instance type: kafka.m5.2xlarge (8 vCPU, 32 GB RAM)
- Storage: 2 TB per broker
- Replication factor: 3
- Min in-sync replicas: 2

**PostgreSQL**:
- Instance type: db.r5.2xlarge (8 vCPU, 64 GB RAM)
- Storage: 1 TB SSD (gp3)
- Multi-AZ: Enabled
- Read replicas: 2+ for read-heavy workloads
- Backup retention: 30 days

**Redis**:
- Instance type: cache.r5.xlarge (4 vCPU, 26 GB RAM)
- Cluster mode: Enabled (3 shards, 2 replicas per shard)
- Backup retention: 7 days

## Security Best Practices

### 1. Network Security

**VPC Configuration**:
```yaml
# Private subnets for all services
subnets:
  - private-subnet-az1
  - private-subnet-az2
  - private-subnet-az3

# Security groups
securityGroups:
  gateway:
    ingress:
      - port: 8443
        source: load-balancer-sg
    egress:
      - port: 9092
        destination: kafka-sg
      - port: 5432
        destination: postgres-sg
  
  kafka:
    ingress:
      - port: 9092
        source: gateway-sg, consumer-sg
  
  postgres:
    ingress:
      - port: 5432
        source: gateway-sg, consumer-sg
```

**Network Policies**:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: caracal-network-policy
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: caracal
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: caracal
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: caracal
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 53  # DNS
```

### 2. Authentication and Authorization

**Kafka SASL/SSL**:
```yaml
kafka:
  security:
    protocol: SASL_SSL
    saslMechanism: SCRAM-SHA-512
    saslUsername: caracal-producer
    saslPassword: <from-secret>
  ssl:
    truststoreLocation: /etc/kafka/secrets/truststore.jks
    keystoreLocation: /etc/kafka/secrets/keystore.jks
```

**PostgreSQL SSL**:
```yaml
postgresql:
  ssl:
    enabled: true
    mode: require
    cert: /etc/ssl/certs/client-cert.pem
    key: /etc/ssl/private/client-key.pem
    rootCert: /etc/ssl/certs/ca-cert.pem
```

**Redis TLS**:
```yaml
redis:
  tls:
    enabled: true
    certFile: /etc/redis/certs/redis.crt
    keyFile: /etc/redis/certs/redis.key
    caCertFile: /etc/redis/certs/ca.crt
```

### 3. Secrets Management

Use external secrets management:

**AWS Secrets Manager**:
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: caracal-secrets
spec:
  secretStoreRef:
    name: aws-secrets-manager
  target:
    name: caracal-secrets
  data:
    - secretKey: DB_PASSWORD
      remoteRef:
        key: caracal/production/db-password
    - secretKey: REDIS_PASSWORD
      remoteRef:
        key: caracal/production/redis-password
```

**HashiCorp Vault**:
```yaml
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: caracal-vault-secrets
spec:
  provider: vault
  parameters:
    vaultAddress: "https://vault.example.com"
    roleName: "caracal-role"
    objects: |
      - objectName: "db-password"
        secretPath: "secret/data/caracal/db"
        secretKey: "password"
```

### 4. Encryption

**Encryption at Rest**:
- PostgreSQL: Enable encryption at rest (AWS RDS encryption)
- Kafka: Enable encryption at rest (AWS MSK encryption)
- Redis: Enable encryption at rest (ElastiCache encryption)
- Kubernetes volumes: Use encrypted storage classes

**Encryption in Transit**:
- All services communicate over TLS
- Kafka: SASL_SSL
- PostgreSQL: SSL required
- Redis: TLS enabled

### 5. Audit Logging

Enable audit logging for all components:

```yaml
auditLogger:
  enabled: true
  retentionDays: 2555  # 7 years
  exportFormats:
    - json
    - syslog
  destinations:
    - s3://audit-logs-bucket/caracal/
    - syslog://siem.example.com:514
```

## High Availability

### 1. Multi-AZ Deployment

Deploy across 3 availability zones:

```yaml
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchExpressions:
            - key: app.kubernetes.io/component
              operator: In
              values:
                - gateway
        topologyKey: topology.kubernetes.io/zone
```

### 2. Pod Disruption Budgets

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: caracal-gateway-pdb
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app.kubernetes.io/component: gateway
```

### 3. Health Checks

Configure aggressive health checks:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8443
    scheme: HTTPS
  initialDelaySeconds: 30
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health
    port: 8443
    scheme: HTTPS
  initialDelaySeconds: 10
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 2
```

### 4. Database High Availability

**PostgreSQL Multi-AZ**:
- Enable Multi-AZ deployment
- Configure automatic failover
- Set up read replicas for read scaling
- Use connection pooling (PgBouncer)

**Redis Cluster**:
- Enable cluster mode
- 3 shards with 2 replicas each
- Automatic failover enabled

### 5. Kafka High Availability

**Kafka Configuration**:
```properties
# Replication
default.replication.factor=3
min.insync.replicas=2
unclean.leader.election.enable=false

# Durability
acks=all
enable.idempotence=true

# Availability
replica.lag.time.max.ms=10000
```

## Performance Tuning

### 1. Gateway Proxy Tuning

```yaml
gateway:
  config:
    # Connection pooling
    dbPoolSize: 20
    dbMaxOverflow: 10
    dbPoolTimeout: 30
    
    # Request handling
    maxConcurrentRequests: 1000
    requestTimeout: 30
    
    # Cache tuning
    policyCacheTTL: 60
    policyCacheMaxSize: 50000
    
    # Provisional charges
    provisionalChargeExpiration: 300
    provisionalChargeCleanupInterval: 30
```

### 2. Kafka Tuning

**Producer Configuration**:
```properties
# Throughput
batch.size=32768
linger.ms=10
compression.type=snappy
buffer.memory=67108864

# Reliability
acks=all
enable.idempotence=true
max.in.flight.requests.per.connection=5
```

**Consumer Configuration**:
```properties
# Throughput
fetch.min.bytes=1024
fetch.max.wait.ms=500
max.poll.records=500

# Reliability
enable.auto.commit=false
isolation.level=read_committed
```

**Broker Configuration**:
```properties
# Performance
num.network.threads=8
num.io.threads=8
socket.send.buffer.bytes=102400
socket.receive.buffer.bytes=102400

# Storage
log.segment.bytes=1073741824
log.retention.hours=720
log.retention.check.interval.ms=300000
compression.type=snappy
```

### 3. PostgreSQL Tuning

```sql
-- Connection pooling
max_connections = 200
shared_buffers = 8GB
effective_cache_size = 24GB

-- Query performance
work_mem = 64MB
maintenance_work_mem = 1GB
random_page_cost = 1.1

-- Write performance
wal_buffers = 16MB
checkpoint_completion_target = 0.9
max_wal_size = 4GB

-- Autovacuum
autovacuum_max_workers = 4
autovacuum_naptime = 10s
```

### 4. Redis Tuning

```conf
# Memory
maxmemory 24gb
maxmemory-policy allkeys-lru

# Persistence
save 900 1
save 300 10
save 60 10000
appendonly yes
appendfsync everysec

# Performance
tcp-backlog 511
timeout 0
tcp-keepalive 300
```

### 5. Merkle Batch Tuning

```yaml
consumers:
  ledgerWriter:
    merkle:
      # Adjust based on event rate
      batchSizeLimit: 10000  # Larger batches for high throughput
      batchTimeoutSeconds: 600  # 10 minutes
      
      # Or smaller batches for faster tamper detection
      batchSizeLimit: 1000
      batchTimeoutSeconds: 300  # 5 minutes
```

## Monitoring and Alerting

### 1. Key Metrics to Monitor

**Gateway Metrics**:
- Request rate (requests/sec)
- Request latency (p50, p95, p99)
- Error rate (%)
- Policy evaluation time
- Provisional charge creation rate

**Kafka Metrics**:
- Consumer lag (messages)
- Producer throughput (messages/sec)
- Broker CPU/memory usage
- Disk usage
- Under-replicated partitions

**Consumer Metrics**:
- Processing rate (events/sec)
- Processing latency
- Error rate
- DLQ size

**Database Metrics**:
- Connection count
- Query latency
- Transaction rate
- Replication lag
- Disk usage

**Merkle Metrics**:
- Batch size
- Batch processing time
- Signature generation time
- Verification failures

### 2. Alerting Rules

```yaml
groups:
  - name: caracal-alerts
    rules:
      # High error rate
      - alert: HighErrorRate
        expr: rate(caracal_requests_total{status="error"}[5m]) > 0.05
        for: 5m
        annotations:
          summary: "High error rate detected"
      
      # High consumer lag
      - alert: HighConsumerLag
        expr: kafka_consumer_lag > 10000
        for: 10m
        annotations:
          summary: "Kafka consumer lag is high"
      
      # DLQ size
      - alert: HighDLQSize
        expr: caracal_dlq_size > 1000
        for: 5m
        annotations:
          summary: "Dead letter queue size is high"
      
      # Merkle verification failure
      - alert: MerkleVerificationFailure
        expr: caracal_merkle_verification_failures_total > 0
        for: 1m
        annotations:
          summary: "Merkle verification failure detected"
      
      # Database connection issues
      - alert: DatabaseConnectionFailure
        expr: up{job="postgres"} == 0
        for: 2m
        annotations:
          summary: "Database connection failure"
```

### 3. Grafana Dashboards

Import dashboards from `monitoring/grafana/`:
- `caracal-overview.json`: System overview
- `caracal-gateway.json`: Gateway metrics
- `caracal-kafka.json`: Kafka metrics
- `caracal-consumers.json`: Consumer metrics
- `caracal-merkle.json`: Merkle tree operations
- `caracal-spending.json`: Spending trends

## Disaster Recovery

### 1. Backup Strategy

**PostgreSQL Backups**:
- Automated daily backups (AWS RDS automated backups)
- Retention: 30 days
- Point-in-time recovery enabled
- Manual snapshots before major changes

**Kafka Backups**:
- MirrorMaker 2 for cross-region replication
- Retention: 30 days in primary region
- 7 days in backup region

**Configuration Backups**:
- Store all Kubernetes manifests in Git
- Backup Helm values files
- Backup secrets to secure vault

### 2. Recovery Procedures

**Database Recovery**:
```bash
# Restore from automated backup
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier caracal-restored \
  --db-snapshot-identifier caracal-snapshot-20260203

# Point-in-time recovery
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier caracal-prod \
  --target-db-instance-identifier caracal-restored \
  --restore-time 2026-02-03T10:00:00Z
```

**Kafka Recovery**:
```bash
# Replay events from backup region
caracal replay start --from-region us-west-2 --from-timestamp 2026-02-03T00:00:00Z
```

**Snapshot Recovery**:
```bash
# Restore from snapshot
caracal snapshot restore --snapshot-id snapshot-20260203-000000

# Replay events after snapshot
caracal replay start --from-snapshot snapshot-20260203-000000
```

### 3. Failover Procedures

**Regional Failover**:
1. Update DNS to point to secondary region
2. Promote read replica to primary
3. Start consumers in secondary region
4. Verify data consistency
5. Monitor for issues

**Database Failover**:
1. AWS RDS automatic failover (Multi-AZ)
2. Update connection strings if needed
3. Verify application connectivity
4. Monitor replication lag

## Capacity Planning

### 1. Sizing Guidelines

**Events per Second**:
- 1,000 events/sec: Small deployment (current configuration)
- 10,000 events/sec: Medium deployment (2x resources)
- 100,000 events/sec: Large deployment (10x resources)

**Storage Growth**:
- Ledger events: ~1 KB per event
- Audit logs: ~2 KB per event
- Merkle roots: ~500 bytes per batch
- Monthly growth: events/sec × 2.6M × 3 KB

**Example**:
- 10,000 events/sec
- Monthly storage: 10,000 × 2.6M × 3 KB = 78 GB/month
- Annual storage: 936 GB/year

### 2. Scaling Triggers

**Scale Up When**:
- CPU utilization > 70% for 10 minutes
- Memory utilization > 80% for 10 minutes
- Kafka consumer lag > 10,000 messages
- Request latency p99 > 1 second
- Error rate > 1%

**Scale Down When**:
- CPU utilization < 30% for 30 minutes
- Memory utilization < 40% for 30 minutes
- Kafka consumer lag < 1,000 messages
- Request latency p99 < 100ms

## Operational Runbook

### Common Operations

**1. Create Agent**:
```bash
caracal agent create \
  --name "production-agent-1" \
  --type "openai" \
  --metadata '{"team":"platform","env":"prod"}'
```

**2. Create Policy**:
```bash
caracal policy create \
  --agent-id <agent-id> \
  --limit 1000.00 \
  --currency USD \
  --time-window daily \
  --window-type calendar
```

**3. Query Spending**:
```bash
caracal ledger query \
  --agent-id <agent-id> \
  --start-date 2026-02-01 \
  --end-date 2026-02-03
```

**4. Verify Merkle Integrity**:
```bash
caracal merkle verify-range \
  --start 2026-02-01 \
  --end 2026-02-03
```

**5. Create Snapshot**:
```bash
caracal snapshot create
```

**6. Scale Deployment**:
```bash
kubectl scale deployment caracal-gateway -n caracal --replicas=10
```

### Troubleshooting Procedures

See [DEPLOYMENT_GUIDE_V03.md](DEPLOYMENT_GUIDE_V03.md#troubleshooting) for detailed troubleshooting procedures.

## Support

For production support:

- Email: support@caracal.dev
- Slack: caracal-community.slack.com
- On-call: +1-555-CARACAL
- Documentation: https://caracal.dev/docs
