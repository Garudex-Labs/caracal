# Kafka CLI Commands

This document describes the Kafka management commands available in Caracal Core v0.3.

## Overview

The `caracal kafka` command group provides tools for managing Kafka topics used by Caracal Core. These commands allow you to create, list, and inspect Kafka topics without needing to use Kafka's native command-line tools.

## Prerequisites

Install the required dependencies:

```bash
pip install kafka-python
```

Or install Caracal Core with Kafka support:

```bash
pip install caracal-core[kafka]
```

## Commands

### create-topics

Create all Caracal Core Kafka topics with proper configuration.

**Usage:**
```bash
caracal kafka create-topics [OPTIONS]
```

**Options:**
- `--bootstrap-servers TEXT`: Kafka bootstrap servers (comma-separated) [default: localhost:9093]
- `--config-file PATH`: Kafka client configuration file (for authentication)
- `--replication-factor INTEGER`: Replication factor for topics [default: 3]
- `--min-insync-replicas INTEGER`: Minimum in-sync replicas [default: 2]
- `--retention-days INTEGER`: Retention period in days [default: 30]
- `--dry-run`: Show what would be created without actually creating topics

**Topics Created:**
- `caracal.metering.events` (10 partitions) - Metering events from gateway proxy and MCP adapter
- `caracal.policy.decisions` (5 partitions) - Policy evaluation decisions (allow/deny)
- `caracal.agent.lifecycle` (3 partitions) - Agent lifecycle events (created, updated, deleted)
- `caracal.policy.changes` (3 partitions) - Policy change events for versioning and audit trail
- `caracal.dlq` (3 partitions) - Dead letter queue for failed event processing

**Topic Configuration:**
- Replication factor: 3 (configurable)
- Min in-sync replicas: 2 (configurable)
- Retention: 30 days (configurable)
- Compression: snappy
- Cleanup policy: delete

**Examples:**

Create topics with default settings:
```bash
caracal kafka create-topics
```

Create topics with custom configuration:
```bash
caracal kafka create-topics \
  --replication-factor 1 \
  --retention-days 7
```

Dry run to see what would be created:
```bash
caracal kafka create-topics --dry-run
```

Use authentication (SASL/SCRAM):
```bash
caracal kafka create-topics \
  --config-file kafka-certs/client.properties
```

Create topics on remote Kafka cluster:
```bash
caracal kafka create-topics \
  --bootstrap-servers kafka1.example.com:9093,kafka2.example.com:9093 \
  --config-file kafka-certs/client.properties
```

**Output:**
```
============================================================
Kafka Topics Creation
============================================================

Bootstrap servers: localhost:9093
Replication factor: 3
Min in-sync replicas: 2
Retention: 30 days
Compression: snappy

Connecting to Kafka...
✓ Connected to Kafka

Creating topic: caracal.metering.events
  Partitions: 10
  Description: Metering events from gateway proxy and MCP adapter
Creating topic: caracal.policy.decisions
  Partitions: 5
  Description: Policy evaluation decisions (allow/deny)
Creating topic: caracal.agent.lifecycle
  Partitions: 3
  Description: Agent lifecycle events (created, updated, deleted)
Creating topic: caracal.policy.changes
  Partitions: 3
  Description: Policy change events for versioning and audit trail
Creating topic: caracal.dlq
  Partitions: 3
  Description: Dead letter queue for failed event processing

✓ Topic created: caracal.metering.events
✓ Topic created: caracal.policy.decisions
✓ Topic created: caracal.agent.lifecycle
✓ Topic created: caracal.policy.changes
✓ Topic created: caracal.dlq

============================================================
Topics created successfully!
============================================================
```

### list-topics

List all Kafka topics.

**Usage:**
```bash
caracal kafka list-topics [OPTIONS]
```

**Options:**
- `--bootstrap-servers TEXT`: Kafka bootstrap servers (comma-separated) [default: localhost:9093]
- `--config-file PATH`: Kafka client configuration file (for authentication)
- `--filter TEXT`: Filter topics by prefix (e.g., 'caracal.')

**Examples:**

List all topics:
```bash
caracal kafka list-topics
```

List only Caracal topics:
```bash
caracal kafka list-topics --filter caracal.
```

Use authentication:
```bash
caracal kafka list-topics \
  --config-file kafka-certs/client.properties
```

**Output:**
```
============================================================
Kafka Topics (5 total)
============================================================

  caracal.agent.lifecycle
  caracal.dlq
  caracal.metering.events
  caracal.policy.changes
  caracal.policy.decisions
```

### describe-topic

Describe a specific Kafka topic with detailed information.

**Usage:**
```bash
caracal kafka describe-topic TOPIC [OPTIONS]
```

**Arguments:**
- `TOPIC`: Name of the topic to describe

**Options:**
- `--bootstrap-servers TEXT`: Kafka bootstrap servers (comma-separated) [default: localhost:9093]
- `--config-file PATH`: Kafka client configuration file (for authentication)

**Examples:**

Describe a topic:
```bash
caracal kafka describe-topic caracal.metering.events
```

Use authentication:
```bash
caracal kafka describe-topic caracal.metering.events \
  --config-file kafka-certs/client.properties
```

**Output:**
```
============================================================
Topic: caracal.metering.events
============================================================

Partitions: 10
Replication factor: 3

Partition Details:

  Partition 0:
    Leader: 1
    Replicas: [1, 2, 3]
    In-Sync Replicas: [1, 2, 3]

  Partition 1:
    Leader: 2
    Replicas: [2, 3, 1]
    In-Sync Replicas: [2, 3, 1]

  ... (remaining partitions)

Configuration:

  min.insync.replicas: 2
  retention.ms: 2592000000
  compression.type: snappy
  cleanup.policy: delete
```

## Authentication

### Using Configuration File

Create a Kafka client configuration file (e.g., `client.properties`):

```properties
security.protocol=SASL_SSL
sasl.mechanism=SCRAM-SHA-512
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required \
    username="admin" \
    password="admin-secret";

ssl.truststore.location=/path/to/kafka.truststore.jks
ssl.truststore.password=changeit
ssl.keystore.location=/path/to/kafka.keystore.jks
ssl.keystore.password=changeit
ssl.key.password=changeit
```

Then use it with any command:

```bash
caracal kafka list-topics --config-file client.properties
```

### Using Environment Variables

You can also set Kafka configuration via environment variables:

```bash
export KAFKA_BOOTSTRAP_SERVERS=localhost:9093
export KAFKA_SECURITY_PROTOCOL=SASL_SSL
export KAFKA_SASL_MECHANISM=SCRAM-SHA-512
export KAFKA_SASL_USERNAME=admin
export KAFKA_SASL_PASSWORD=admin-secret
```

## Common Workflows

### Initial Setup

1. Start Kafka cluster:
   ```bash
   docker-compose -f docker-compose.kafka.yml up -d
   ```

2. Wait for Kafka to be ready:
   ```bash
   docker-compose -f docker-compose.kafka.yml logs -f kafka-1
   ```

3. Create SCRAM credentials (see KAFKA_SETUP.md)

4. Create Caracal topics:
   ```bash
   caracal kafka create-topics --config-file kafka-certs/client.properties
   ```

5. Verify topics were created:
   ```bash
   caracal kafka list-topics --filter caracal.
   ```

### Inspecting Topics

Check topic configuration:
```bash
caracal kafka describe-topic caracal.metering.events
```

Check all Caracal topics:
```bash
for topic in $(caracal kafka list-topics --filter caracal. | grep caracal); do
  echo "=== $topic ==="
  caracal kafka describe-topic $topic
  echo ""
done
```

### Development vs Production

**Development** (single broker, no replication):
```bash
caracal kafka create-topics \
  --replication-factor 1 \
  --min-insync-replicas 1 \
  --retention-days 7
```

**Production** (3 brokers, full replication):
```bash
caracal kafka create-topics \
  --replication-factor 3 \
  --min-insync-replicas 2 \
  --retention-days 30 \
  --config-file kafka-certs/client.properties
```

## Troubleshooting

### Connection Refused

**Error:**
```
Error: [Errno 111] Connection refused
```

**Solution:**
- Verify Kafka is running: `docker-compose -f docker-compose.kafka.yml ps`
- Check bootstrap servers address: `--bootstrap-servers localhost:9093`
- Check firewall rules

### Authentication Failed

**Error:**
```
Error: Authentication failed
```

**Solution:**
- Verify SCRAM credentials were created in Kafka
- Check username/password in configuration file
- Verify SSL certificates are valid

### Topic Already Exists

**Warning:**
```
⚠ Topic already exists: caracal.metering.events
```

**Solution:**
- This is not an error, the topic was already created
- To recreate, delete the topic first (requires Kafka admin tools)

### Permission Denied

**Error:**
```
Error: Not authorized to create topic
```

**Solution:**
- Verify user has CREATE permission on cluster
- Check Kafka ACLs: `kafka-acls --list --bootstrap-server localhost:9093`
- Use admin credentials

## Integration with Caracal Core

After creating topics, configure Caracal Core to use Kafka:

**config.yaml:**
```yaml
kafka:
  enabled: true
  bootstrap_servers:
    - localhost:9093
  security_protocol: SASL_SSL
  sasl_mechanism: SCRAM-SHA-512
  sasl_username: producer
  sasl_password: producer-secret
  ssl_truststore_location: /path/to/kafka.truststore.jks
  ssl_truststore_password: changeit
  
  topics:
    metering_events: caracal.metering.events
    policy_decisions: caracal.policy.decisions
    agent_lifecycle: caracal.agent.lifecycle
    policy_changes: caracal.policy.changes
    dlq: caracal.dlq
  
  producer:
    acks: all
    retries: 3
    compression_type: snappy
  
  consumer:
    group_id: caracal-consumer-group
    auto_offset_reset: earliest
    enable_auto_commit: false
```

## See Also

- [KAFKA_SETUP.md](KAFKA_SETUP.md) - Complete Kafka infrastructure setup guide
- [schemas/README.md](schemas/README.md) - Avro schema documentation
- [Kafka Documentation](https://kafka.apache.org/documentation/)
- [Confluent Python Client](https://docs.confluent.io/kafka-clients/python/current/overview.html)
