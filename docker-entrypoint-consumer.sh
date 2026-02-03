#!/bin/bash
# Docker entrypoint script for Caracal Kafka Consumers
# Starts the appropriate consumer based on CONSUMER_TYPE environment variable

set -e

# Default to ledger-writer if not specified
CONSUMER_TYPE=${CONSUMER_TYPE:-ledger-writer}

echo "Starting Caracal Consumer: ${CONSUMER_TYPE}"
echo "Kafka Bootstrap Servers: ${KAFKA_BOOTSTRAP_SERVERS}"
echo "Consumer Group: ${KAFKA_CONSUMER_GROUP}"

# Wait for Kafka to be ready
echo "Waiting for Kafka to be ready..."
timeout=60
elapsed=0
while ! python -c "from kafka import KafkaConsumer; KafkaConsumer(bootstrap_servers='${KAFKA_BOOTSTRAP_SERVERS}', api_version=(0,10,1))" 2>/dev/null; do
    if [ $elapsed -ge $timeout ]; then
        echo "ERROR: Kafka not ready after ${timeout} seconds"
        exit 1
    fi
    echo "Waiting for Kafka... (${elapsed}s)"
    sleep 2
    elapsed=$((elapsed + 2))
done
echo "Kafka is ready!"

# Start the appropriate consumer
case "${CONSUMER_TYPE}" in
    ledger-writer)
        echo "Starting LedgerWriter Consumer..."
        exec python -m caracal.kafka.ledger_writer
        ;;
    metrics-aggregator)
        echo "Starting MetricsAggregator Consumer..."
        exec python -m caracal.kafka.metrics_aggregator
        ;;
    audit-logger)
        echo "Starting AuditLogger Consumer..."
        exec python -m caracal.kafka.audit_logger
        ;;
    *)
        echo "ERROR: Unknown consumer type: ${CONSUMER_TYPE}"
        echo "Valid types: ledger-writer, metrics-aggregator, audit-logger"
        exit 1
        ;;
esac
