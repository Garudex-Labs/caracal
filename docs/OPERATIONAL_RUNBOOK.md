# Caracal Core v0.3 Operational Runbook

## Table of Contents

1. [Common Operations](#common-operations)
2. [Troubleshooting Procedures](#troubleshooting-procedures)
3. [Backup and Recovery Procedures](#backup-and-recovery-procedures)
4. [Scaling Procedures](#scaling-procedures)
5. [Monitoring and Alerts](#monitoring-and-alerts)
6. [Emergency Procedures](#emergency-procedures)

---

## Common Operations

### 1. Create Agent

**Purpose**: Register a new AI agent in the system.

**Command**:
```bash
caracal agent create \
  --name "my-agent" \
  --description "My AI agent" \
  --owner "user@example.com"
```

**Expected Output**:
```
Agent created successfully:
  Agent ID: 550e8400-e29b-41d4-a716-446655440000
  Name: my-agent
  Owner: user@example.com
  Status: active
```

**Verification**:
```bash
# List all agents
caracal agent list

# Get specific agent details
caracal agent get --agent-id 550e8400-e29b-41d4-a716-446655440000
```

---

### 2. Create Budget Policy

**Purpose**: Set spending limits for an agent.

**Command**:
```bash
caracal policy create \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --limit 100.00 \
  --currency USD \
  --time-window daily \
  --window-type calendar \
  --change-reason "Initial budget allocation"
```

**Expected Output**:
```
Policy created successfully:
  Policy ID: 660e8400-e29b-41d4-a716-446655440001
  Agent ID: 550e8400-e29b-41d4-a716-446655440000
  Limit: $100.00 USD
  Time Window: daily (calendar)
  Status: active
```

**Verification**:
```bash
# List policies for agent
caracal policy list --agent-id 550e8400-e29b-41d4-a716-446655440000

# Check policy history
caracal policy history --agent-id 550e8400-e29b-41d4-a716-446655440000
```

---

### 3. Query Agent Spending

**Purpose**: Check current spending for an agent.

**Command**:
```bash
# Query spending for specific time range
caracal ledger query \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --start-time "2024-01-01T00:00:00Z" \
  --end-time "2024-01-31T23:59:59Z"

# Query current daily spending
caracal ledger query \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --time-window daily
```

**Expected Output**:
```
Spending Summary:
  Agent ID: 550e8400-e29b-41d4-a716-446655440000
  Time Range: 2024-01-01 to 2024-01-31
  Total Spending: $45.67 USD
  Event Count: 1,234
  Average Cost per Event: $0.037
```

---

### 4. Create Resource Allowlist

**Purpose**: Restrict agent access to specific APIs/resources.

**Command**:
```bash
# Create regex allowlist
caracal allowlist create \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --pattern "^https://api\.openai\.com/.*$" \
  --pattern-type regex

# Create glob allowlist
caracal allowlist create \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --pattern "https://api.anthropic.com/*" \
  --pattern-type glob
```

**Expected Output**:
```
Allowlist created successfully:
  Allowlist ID: 770e8400-e29b-41d4-a716-446655440002
  Agent ID: 550e8400-e29b-41d4-a716-446655440000
  Pattern: ^https://api\.openai\.com/.*$
  Pattern Type: regex
  Status: active
```

**Verification**:
```bash
# List allowlists for agent
caracal allowlist list --agent-id 550e8400-e29b-41d4-a716-446655440000

# Test pattern match
caracal allowlist test \
  --agent-id 550e8400-e29b-41d4-a716-446655440000 \
  --resource "https://api.openai.com/v1/chat/completions"
```

---

### 5. Verify Ledger Integrity

**Purpose**: Verify cryptographic integrity of ledger events.

**Command**:
```bash
# Verify specific batch
caracal merkle verify-batch --batch-id 880e8400-e29b-41d4-a716-446655440003

# Verify time range
caracal merkle verify-range \
  --start-time "2024-01-01T00:00:00Z" \
  --end-time "2024-01-31T23:59:59Z"

# Verify specific event
caracal merkle verify-event --event-id 12345
```

**Expected Output**:
```
Verification Result:
  Batch ID: 880e8400-e29b-41d4-a716-446655440003
  Event Count: 1,000
  Merkle Root: 0x1234567890abcdef...
  Signature: Valid
  Integrity: PASSED
  Tamper Detected: No
```

---

### 6. Create Ledger Snapshot

**Purpose**: Create point-in-time snapshot for fast recovery.

**Command**:
```bash
# Create snapshot
caracal snapshot create

# List snapshots
caracal snapshot list

# Restore from snapshot
caracal snapshot restore --snapshot-id 990e8400-e29b-41d4-a716-446655440004
```

**Expected Output**:
```
Snapshot created successfully:
  Snapshot ID: 990e8400-e29b-41d4-a716-446655440004
  Timestamp: 2024-01-15T00:00:00Z
  Total Events: 1,234,567
  Merkle Root: 0xabcdef1234567890...
  Size: 45.6 MB
```

---

### 7. Monitor Dead Letter Queue

**Purpose**: Check for failed events requiring manual intervention.

**Command**:
```bash
# List DLQ events
caracal dlq list

# List DLQ events with filters
caracal dlq list \
  --start-time "2024-01-01T00:00:00Z" \
  --error-type "PolicyEvaluationError"

# Get DLQ event details
caracal dlq get --event-id 12345
```

**Expected Output**:
```
Dead Letter Queue Events:
  Total: 5
  
  Event ID: 12345
  Source Topic: caracal.metering.events
  Error Type: PolicyEvaluationError
  Error Message: Database connection timeout
  Retry Count: 3
  Failed At: 2024-01-15T10:30:00Z
```

---

## Troubleshooting Procedures

### Issue: Gateway Returns 503 Service Unavailable

**Symptoms**:
- Gateway health check returns 503
- Requests fail with "Service Unavailable"

**Diagnosis**:
```bash
# Check gateway health
curl http://gateway:8443/health

# Check gateway logs
kubectl logs -f deployment/caracal-gateway --tail=100

# Check database connectivity
caracal db health-check
```

**Common Causes**:
1. **Database Unavailable**
   - Check PostgreSQL pod status: `kubectl get pods -l app=postgresql`
   - Check PostgreSQL logs: `kubectl logs -f statefulset/postgresql`
   - Verify database credentials in gateway config

2. **Kafka Unavailable**
   - Check Kafka pod status: `kubectl get pods -l app=kafka`
   - Check Kafka logs: `kubectl logs -f statefulset/kafka`
   - Verify Kafka connectivity: `caracal kafka list-topics`

3. **Redis Unavailable**
   - Check Redis pod status: `kubectl get pods -l app=redis`
   - Check Redis logs: `kubectl logs -f deployment/redis`
   - Test Redis connection: `redis-cli -h redis ping`

**Resolution**:
1. If database is down, gateway will enter degraded mode using policy cache
2. Restart failed components: `kubectl rollout restart deployment/<component>`
3. If persistent, check resource limits and scale up if needed

---

### Issue: Kafka Consumer Lag Increasing

**Symptoms**:
- Consumer lag metric increasing
- Events not being processed in real-time
- Prometheus alert: `caracal_kafka_consumer_lag > 10000`

**Diagnosis**:
```bash
# Check consumer lag
caracal kafka consumer-lag --consumer-group ledger-writer-group

# Check consumer logs
kubectl logs -f deployment/caracal-ledger-writer --tail=100

# Check Kafka topic metrics
caracal kafka describe-topic --topic caracal.metering.events
```

**Common Causes**:
1. **Consumer Processing Too Slow**
   - Check consumer processing time metrics
   - Look for slow database queries in logs
   - Check for database connection pool exhaustion

2. **High Event Volume**
   - Check event production rate
   - Verify consumer is scaled appropriately

3. **Consumer Errors**
   - Check DLQ for failed events
   - Look for error patterns in logs

**Resolution**:
1. **Scale Consumer Horizontally**:
   ```bash
   kubectl scale deployment/caracal-ledger-writer --replicas=5
   ```

2. **Optimize Database Queries**:
   - Check slow query logs
   - Add missing indexes
   - Increase connection pool size

3. **Increase Consumer Resources**:
   ```bash
   kubectl set resources deployment/caracal-ledger-writer \
     --limits=cpu=2,memory=4Gi \
     --requests=cpu=1,memory=2Gi
   ```

---

### Issue: Merkle Verification Failures

**Symptoms**:
- Merkle verification returns "FAILED"
- Prometheus alert: `caracal_merkle_verification_failures_total > 0`
- Tamper detected in ledger

**Diagnosis**:
```bash
# Verify specific batch
caracal merkle verify-batch --batch-id <batch-id>

# Check Merkle signer logs
kubectl logs -f deployment/caracal-ledger-writer | grep "merkle"

# Check database for tampering
caracal db query "SELECT * FROM ledger_events WHERE merkle_root_id = '<batch-id>'"
```

**Common Causes**:
1. **Database Corruption**
   - Hardware failure
   - Manual database modification
   - Replication lag

2. **Signing Key Mismatch**
   - Key rotation not completed properly
   - Wrong key used for verification

3. **Software Bug**
   - Hash computation error
   - Serialization issue

**Resolution**:
1. **CRITICAL**: This indicates potential data tampering
2. **Immediate Actions**:
   - Stop all writes to affected batches
   - Preserve evidence (database dumps, logs)
   - Notify security team
   - Investigate root cause

3. **Recovery**:
   - If key mismatch, rotate keys properly
   - If corruption, restore from backup
   - If bug, fix and re-verify

---

### Issue: High Memory Usage

**Symptoms**:
- Pod OOMKilled
- Memory usage > 80%
- Slow performance

**Diagnosis**:
```bash
# Check pod memory usage
kubectl top pods

# Check memory metrics
curl http://gateway:9090/metrics | grep memory

# Check for memory leaks
kubectl exec -it <pod> -- ps aux
```

**Common Causes**:
1. **Policy Cache Too Large**
   - Check cache size: `curl http://gateway:8443/stats`
   - Reduce cache TTL or max size in config

2. **Connection Pool Leaks**
   - Check connection pool metrics
   - Look for unclosed connections

3. **Large Event Batches**
   - Check Merkle batch size
   - Reduce batch size in config

**Resolution**:
1. **Increase Memory Limits**:
   ```bash
   kubectl set resources deployment/<component> \
     --limits=memory=8Gi \
     --requests=memory=4Gi
   ```

2. **Tune Configuration**:
   - Reduce policy cache size
   - Reduce Merkle batch size
   - Reduce connection pool size

3. **Restart Pod**:
   ```bash
   kubectl rollout restart deployment/<component>
   ```

---

## Backup and Recovery Procedures

### PostgreSQL Backup

**Daily Automated Backup**:
```bash
# Backup script (run via cron)
#!/bin/bash
BACKUP_DIR="/backups/postgresql"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/caracal_backup_$TIMESTAMP.sql.gz"

# Create backup
kubectl exec -it postgresql-0 -- \
  pg_dump -U caracal caracal | gzip > "$BACKUP_FILE"

# Verify backup
gunzip -t "$BACKUP_FILE"

# Upload to S3 (optional)
aws s3 cp "$BACKUP_FILE" s3://caracal-backups/postgresql/

# Cleanup old backups (keep 30 days)
find "$BACKUP_DIR" -name "caracal_backup_*.sql.gz" -mtime +30 -delete
```

**Manual Backup**:
```bash
# Create backup
caracal backup create --type postgresql

# List backups
caracal backup list

# Verify backup
caracal backup verify --backup-id <backup-id>
```

---

### PostgreSQL Restore

**From Backup File**:
```bash
# Stop all consumers
kubectl scale deployment/caracal-ledger-writer --replicas=0
kubectl scale deployment/caracal-metrics-aggregator --replicas=0
kubectl scale deployment/caracal-audit-logger --replicas=0

# Restore database
gunzip -c /backups/postgresql/caracal_backup_20240115_000000.sql.gz | \
  kubectl exec -i postgresql-0 -- psql -U caracal caracal

# Verify restore
caracal db health-check

# Restart consumers
kubectl scale deployment/caracal-ledger-writer --replicas=3
kubectl scale deployment/caracal-metrics-aggregator --replicas=2
kubectl scale deployment/caracal-audit-logger --replicas=1
```

**From Snapshot**:
```bash
# List snapshots
caracal snapshot list

# Restore from snapshot
caracal snapshot restore --snapshot-id <snapshot-id>

# Replay events since snapshot
caracal replay start --from-snapshot <snapshot-id>
```

---

### Kafka Topic Backup

**Backup Kafka Topics**:
```bash
# Backup script
#!/bin/bash
BACKUP_DIR="/backups/kafka"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Export topic data
kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic caracal.metering.events \
  --from-beginning \
  --max-messages 1000000 \
  > "$BACKUP_DIR/metering_events_$TIMESTAMP.json"

# Compress backup
gzip "$BACKUP_DIR/metering_events_$TIMESTAMP.json"

# Upload to S3
aws s3 cp "$BACKUP_DIR/metering_events_$TIMESTAMP.json.gz" \
  s3://caracal-backups/kafka/
```

---

### Event Replay Recovery

**Scenario**: Database corrupted, need to rebuild from Kafka events.

**Procedure**:
```bash
# 1. Stop all consumers
kubectl scale deployment/caracal-ledger-writer --replicas=0
kubectl scale deployment/caracal-metrics-aggregator --replicas=0
kubectl scale deployment/caracal-audit-logger --replicas=0

# 2. Clear database (CAUTION!)
caracal db reset --confirm

# 3. Restore from latest snapshot (if available)
caracal snapshot restore --snapshot-id <latest-snapshot-id>

# 4. Replay events from snapshot timestamp
caracal replay start \
  --from-timestamp "2024-01-15T00:00:00Z" \
  --consumer-group ledger-writer-group

# 5. Monitor replay progress
caracal replay status

# 6. Verify integrity after replay
caracal merkle verify-range \
  --start-time "2024-01-15T00:00:00Z" \
  --end-time "now"

# 7. Restart consumers
kubectl scale deployment/caracal-ledger-writer --replicas=3
kubectl scale deployment/caracal-metrics-aggregator --replicas=2
kubectl scale deployment/caracal-audit-logger --replicas=1
```

---

## Scaling Procedures

### Horizontal Scaling

**Scale Gateway**:
```bash
# Scale up
kubectl scale deployment/caracal-gateway --replicas=5

# Verify scaling
kubectl get pods -l app=caracal-gateway

# Check load distribution
kubectl top pods -l app=caracal-gateway
```

**Scale Consumers**:
```bash
# Scale LedgerWriter (up to number of Kafka partitions)
kubectl scale deployment/caracal-ledger-writer --replicas=10

# Scale MetricsAggregator
kubectl scale deployment/caracal-metrics-aggregator --replicas=5

# Scale AuditLogger
kubectl scale deployment/caracal-audit-logger --replicas=3
```

**Auto-Scaling**:
```bash
# Enable HPA for gateway
kubectl autoscale deployment/caracal-gateway \
  --min=3 \
  --max=10 \
  --cpu-percent=70

# Enable HPA for consumers
kubectl autoscale deployment/caracal-ledger-writer \
  --min=3 \
  --max=10 \
  --cpu-percent=70
```

---

### Vertical Scaling

**Increase Resources**:
```bash
# Increase gateway resources
kubectl set resources deployment/caracal-gateway \
  --limits=cpu=4,memory=8Gi \
  --requests=cpu=2,memory=4Gi

# Increase consumer resources
kubectl set resources deployment/caracal-ledger-writer \
  --limits=cpu=2,memory=4Gi \
  --requests=cpu=1,memory=2Gi
```

---

### Database Scaling

**Increase Connection Pool**:
```yaml
# Update config
database:
  pool_size: 50  # Increase from 20
  max_overflow: 100  # Increase from 50
```

**Add Read Replicas**:
```bash
# Deploy read replica
kubectl apply -f postgresql-replica.yaml

# Update config to use replica for reads
database:
  read_replica_url: "postgresql://replica:5432/caracal"
```

---

### Kafka Scaling

**Add Kafka Brokers**:
```bash
# Scale Kafka StatefulSet
kubectl scale statefulset/kafka --replicas=5

# Verify brokers
caracal kafka list-brokers
```

**Increase Topic Partitions**:
```bash
# Increase partitions (cannot be decreased!)
kafka-topics --bootstrap-server kafka:9092 \
  --alter \
  --topic caracal.metering.events \
  --partitions 20
```

---

## Monitoring and Alerts

### Key Metrics to Monitor

1. **Gateway Metrics**:
   - `caracal_gateway_requests_total` - Total requests
   - `caracal_gateway_request_duration_seconds` - Request latency
   - `caracal_policy_evaluations_total` - Policy evaluations
   - `caracal_gateway_auth_failures_total` - Auth failures

2. **Consumer Metrics**:
   - `caracal_kafka_consumer_lag` - Consumer lag
   - `caracal_kafka_message_processing_duration_seconds` - Processing time
   - `caracal_kafka_consumer_errors_total` - Consumer errors

3. **Merkle Metrics**:
   - `caracal_merkle_batches_created_total` - Batches created
   - `caracal_merkle_verification_failures_total` - Verification failures
   - `caracal_merkle_batch_processing_duration_seconds` - Batch processing time

4. **Database Metrics**:
   - `caracal_database_queries_total` - Query count
   - `caracal_database_query_duration_seconds` - Query latency
   - `caracal_database_connection_pool_size` - Connection pool size

5. **DLQ Metrics**:
   - `caracal_dlq_size` - DLQ size
   - `caracal_dlq_oldest_message_age_seconds` - Oldest message age

---

### Grafana Dashboards

**Import Dashboards**:
```bash
# Import pre-built dashboards
kubectl apply -f monitoring/grafana/dashboards/
```

**Key Dashboards**:
1. **Caracal Overview** - System-wide metrics
2. **Gateway Performance** - Gateway request metrics
3. **Kafka Consumers** - Consumer lag and throughput
4. **Merkle Tree Operations** - Batch processing and verification
5. **Database Performance** - Query performance and connection pool

---

## Emergency Procedures

### Complete System Outage

**Immediate Actions**:
1. Check infrastructure status (Kubernetes, network)
2. Check all pod statuses: `kubectl get pods --all-namespaces`
3. Check recent changes: `kubectl rollout history deployment/<component>`
4. Check logs for all components

**Recovery**:
1. Restart all components in order:
   ```bash
   # 1. Database
   kubectl rollout restart statefulset/postgresql
   
   # 2. Kafka
   kubectl rollout restart statefulset/kafka
   
   # 3. Redis
   kubectl rollout restart deployment/redis
   
   # 4. Gateway
   kubectl rollout restart deployment/caracal-gateway
   
   # 5. Consumers
   kubectl rollout restart deployment/caracal-ledger-writer
   kubectl rollout restart deployment/caracal-metrics-aggregator
   kubectl rollout restart deployment/caracal-audit-logger
   ```

2. Verify health:
   ```bash
   curl http://gateway:8443/health
   ```

3. If still failing, restore from backup

---

### Data Corruption Detected

**Immediate Actions**:
1. **STOP ALL WRITES**:
   ```bash
   kubectl scale deployment/caracal-gateway --replicas=0
   kubectl scale deployment/caracal-ledger-writer --replicas=0
   ```

2. **Preserve Evidence**:
   ```bash
   # Database dump
   caracal backup create --type postgresql --tag "corruption-evidence"
   
   # Kafka topic backup
   caracal backup create --type kafka --tag "corruption-evidence"
   
   # Collect logs
   kubectl logs deployment/caracal-ledger-writer > ledger-writer-logs.txt
   ```

3. **Notify Security Team**

4. **Investigate Root Cause**:
   - Check Merkle verification results
   - Review audit logs
   - Check for unauthorized access

5. **Recovery**:
   - Restore from last known good backup
   - Replay events from Kafka
   - Re-verify integrity

---

### Security Incident

**Immediate Actions**:
1. **Isolate Affected Components**
2. **Rotate All Credentials**:
   ```bash
   # Rotate database password
   caracal db rotate-password
   
   # Rotate Kafka credentials
   caracal kafka rotate-credentials
   
   # Rotate Merkle signing keys
   caracal merkle rotate-keys
   ```

3. **Review Audit Logs**:
   ```bash
   caracal audit query \
     --start-time "2024-01-01T00:00:00Z" \
     --event-type "policy_change,agent_lifecycle"
   ```

4. **Notify Security Team**

5. **Conduct Forensic Analysis**

---

## Support Contacts

- **On-Call Engineer**: oncall@example.com
- **Security Team**: security@example.com
- **Database Team**: dba@example.com
- **Platform Team**: platform@example.com

---

## Additional Resources

- [Caracal Core Documentation](./README.md)
- [Deployment Guide](./DEPLOYMENT_GUIDE_V03.md)
- [Production Guide](./PRODUCTION_GUIDE_V03.md)
- [Architecture Documentation](./docs/architecture/)
- [API Documentation](./docs/api/)
