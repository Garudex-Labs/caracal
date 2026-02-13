---
sidebar_position: 5
title: Operational Runbook
---

# Operational Runbook

This runbook covers day-to-day operations for Caracal Core.

## Common Operations

### Register Principal

```bash
caracal agent register \
  --name "my-agent" \
  --description "My AI agent" \
  --owner "user@example.com"
```

### Create Authority Policy

```bash
caracal policy create \
  --agent-id <principal-id> \
  --resources "api:external/*" \
  --actions "read" "write" "execute" \
  --max-validity 86400 \
  --delegation-depth 1
```

### Query Principal Activity

```bash
caracal ledger query \
  --agent-id <principal-id> \
  --start-time "2024-01-01T00:00:00Z" \
  --end-time "2024-01-31T23:59:59Z"

# Current daily activity
caracal ledger query \
  --agent-id <principal-id> \
  --time-window daily
```

### Create Resource Allowlist

```bash
# Regex pattern
caracal allowlist create \
  --agent-id <agent-id> \
  --pattern "^https://api\\.openai\\.com/.*$" \
  --pattern-type regex

# Glob pattern
caracal allowlist create \
  --agent-id <agent-id> \
  --pattern "https://api.anthropic.com/*" \
  --pattern-type glob
```

### Verify Ledger Integrity

```bash
# Verify specific batch
caracal merkle verify-batch --batch-id <batch-id>

# Verify time range
caracal merkle verify-range \
  --start-time "2024-01-01T00:00:00Z" \
  --end-time "2024-01-31T23:59:59Z"
```

### Create Ledger Snapshot

```bash
caracal snapshot create
caracal snapshot list
caracal snapshot restore --snapshot-id <snapshot-id>
```

### Monitor Dead Letter Queue

```bash
caracal dlq list
caracal dlq get --event-id <event-id>
```

## Troubleshooting

### Gateway Returns 503

**Diagnosis:**
```bash
curl http://gateway:8443/health
kubectl logs -f deployment/caracal-gateway --tail=100
caracal db health-check
```

**Common Causes:**
- Database unavailable
- Kafka unavailable
- Redis unavailable

**Resolution:**
```bash
kubectl rollout restart deployment/<component>
```

### Kafka Consumer Lag Increasing

**Diagnosis:**
```bash
caracal kafka consumer-lag --consumer-group ledger-writer-group
kubectl logs -f deployment/caracal-ledger-writer --tail=100
```

**Resolution:**
```bash
# Scale consumers
kubectl scale deployment/caracal-ledger-writer --replicas=5

# Increase resources
kubectl set resources deployment/caracal-ledger-writer \
  --limits=cpu=2,memory=4Gi \
  --requests=cpu=1,memory=2Gi
```

### Merkle Verification Failures

**CRITICAL**: This indicates potential data tampering.

**Immediate Actions:**
1. Stop all writes to affected batches
2. Preserve evidence (database dumps, logs)
3. Notify security team
4. Investigate root cause

### High Memory Usage

**Diagnosis:**
```bash
kubectl top pods
curl http://gateway:9090/metrics | grep memory
```

**Resolution:**
```bash
kubectl set resources deployment/<component> \
  --limits=memory=8Gi \
  --requests=memory=4Gi
```

## Backup and Recovery

### PostgreSQL Backup

```bash
# Manual backup
kubectl exec -it postgresql-0 -- \
  pg_dump -U caracal caracal | gzip > backup.sql.gz

# Using CLI
caracal backup create --type postgresql
```

### PostgreSQL Restore

```bash
# Stop consumers
kubectl scale deployment/caracal-ledger-writer --replicas=0
kubectl scale deployment/caracal-metrics-aggregator --replicas=0

# Restore
gunzip -c backup.sql.gz | \
  kubectl exec -i postgresql-0 -- psql -U caracal caracal

# Verify and restart
caracal db health-check
kubectl scale deployment/caracal-ledger-writer --replicas=3
```

### Event Replay Recovery

```bash
# Stop consumers
kubectl scale deployment/caracal-ledger-writer --replicas=0

# Reset database
caracal db reset --confirm

# Restore from snapshot
caracal snapshot restore --snapshot-id <snapshot-id>

# Replay events
caracal replay start --from-snapshot <snapshot-id>

# Monitor and verify
caracal replay status
caracal merkle verify-range --start-time <timestamp> --end-time now
```

## Scaling

### Horizontal Scaling

```bash
# Gateway
kubectl scale deployment/caracal-gateway --replicas=5

# Consumers
kubectl scale deployment/caracal-ledger-writer --replicas=10

# Auto-scaling
kubectl autoscale deployment/caracal-gateway \
  --min=3 --max=10 --cpu-percent=70
```

### Vertical Scaling

```bash
kubectl set resources deployment/caracal-gateway \
  --limits=cpu=4,memory=8Gi \
  --requests=cpu=2,memory=4Gi
```

### Database Scaling

```yaml
database:
  pool_size: 50
  max_overflow: 100
  read_replica_url: "postgresql://replica:5432/caracal"
```

## Monitoring

### Key Metrics

- `caracal_gateway_requests_total` - Total requests
- `caracal_gateway_request_duration_seconds` - Request latency
- `caracal_kafka_consumer_lag` - Consumer lag
- `caracal_merkle_verification_failures_total` - Verification failures
- `caracal_dlq_size` - Dead letter queue size

### Grafana Dashboards

```bash
kubectl apply -f monitoring/grafana/dashboards/
```

## Emergency Procedures

### Complete System Outage

1. Check infrastructure: `kubectl get pods --all-namespaces`
2. Check recent changes: `kubectl rollout history deployment/<component>`
3. Restart in order: Database > Kafka > Redis > Gateway > Consumers
4. Verify health: `curl http://gateway:8443/health`

### Data Corruption Detected

1. **STOP ALL WRITES:**
   ```bash
   kubectl scale deployment/caracal-gateway --replicas=0
   kubectl scale deployment/caracal-ledger-writer --replicas=0
   ```

2. **Preserve Evidence:**
   ```bash
   caracal backup create --type postgresql --tag "corruption-evidence"
   caracal backup create --type kafka --tag "corruption-evidence"
   ```

3. **Notify Security Team**

4. **Investigate and Recover**
