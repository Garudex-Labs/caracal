#!/bin/bash
#
# Event Replay Recovery Script for Caracal Core
#
# This script performs full event replay recovery by:
# 1. Clearing the database (optional)
# 2. Replaying all events from Kafka from the beginning
# 3. Verifying ledger integrity
#
# Usage:
#   ./event-replay-recovery.sh [options]
#
# Options:
#   --from-timestamp TS   Start replay from timestamp (default: beginning)
#   --clear-database      Clear database before replay (default: false)
#   --verify-integrity    Verify Merkle tree integrity after recovery (default: true)
#   --kubernetes          Use kubectl for Kubernetes deployment (default: false)
#   --namespace NS        Kubernetes namespace (default: caracal)
#   --confirm             Skip confirmation prompt (default: false)

set -euo pipefail

# Default configuration
FROM_TIMESTAMP="${FROM_TIMESTAMP:-}"
CLEAR_DATABASE="${CLEAR_DATABASE:-false}"
VERIFY_INTEGRITY="${VERIFY_INTEGRITY:-true}"
KUBERNETES="${KUBERNETES:-false}"
NAMESPACE="${NAMESPACE:-caracal}"
CONFIRM="${CONFIRM:-false}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --from-timestamp)
      FROM_TIMESTAMP="$2"
      shift 2
      ;;
    --clear-database)
      CLEAR_DATABASE="true"
      shift
      ;;
    --verify-integrity)
      VERIFY_INTEGRITY="true"
      shift
      ;;
    --no-verify-integrity)
      VERIFY_INTEGRITY="false"
      shift
      ;;
    --kubernetes)
      KUBERNETES="true"
      shift
      ;;
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --confirm)
      CONFIRM="true"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "=========================================="
echo "Caracal Event Replay Recovery"
echo "=========================================="
echo "From timestamp: ${FROM_TIMESTAMP:-beginning}"
echo "Clear database: $CLEAR_DATABASE"
echo "Verify integrity: $VERIFY_INTEGRITY"
echo "Kubernetes: $KUBERNETES"
echo "=========================================="

# Confirmation prompt
if [ "$CONFIRM" != "true" ]; then
  echo ""
  echo "WARNING: This will replay events from Kafka."
  if [ "$CLEAR_DATABASE" = "true" ]; then
    echo "The database will be CLEARED before replay!"
  fi
  echo ""
  read -p "Are you sure you want to continue? (yes/no): " RESPONSE
  
  if [ "$RESPONSE" != "yes" ]; then
    echo "Recovery cancelled"
    exit 0
  fi
fi

# Step 1: Stop all consumers
echo ""
echo "Step 1: Stopping Kafka consumers..."
if [ "$KUBERNETES" = "true" ]; then
  kubectl scale deployment/caracal-ledger-writer -n "$NAMESPACE" --replicas=0
  kubectl scale deployment/caracal-metrics-aggregator -n "$NAMESPACE" --replicas=0
  kubectl scale deployment/caracal-audit-logger -n "$NAMESPACE" --replicas=0
  
  echo "Waiting for consumers to stop..."
  sleep 10
else
  echo "WARNING: Not running in Kubernetes, please stop consumers manually"
  read -p "Press Enter when consumers are stopped..."
fi

echo "Consumers stopped"

# Step 2: Clear database if requested
if [ "$CLEAR_DATABASE" = "true" ]; then
  echo ""
  echo "Step 2: Clearing database..."
  
  START_TIME=$(date +%s)
  
  # Clear ledger tables
  caracal db reset --confirm --tables ledger_events,merkle_roots,ledger_snapshots
  
  END_TIME=$(date +%s)
  CLEAR_DURATION=$((END_TIME - START_TIME))
  
  echo "Database cleared in ${CLEAR_DURATION}s"
fi

# Step 3: Replay events from Kafka
echo ""
echo "Step 3: Replaying events from Kafka..."

REPLAY_START_TIME=$(date +%s)

# Build replay command
REPLAY_CMD="caracal replay start --consumer-group ledger-writer-group"

if [ -n "$FROM_TIMESTAMP" ]; then
  REPLAY_CMD="$REPLAY_CMD --from-timestamp $FROM_TIMESTAMP"
  echo "Replaying events since: $FROM_TIMESTAMP"
else
  echo "Replaying all events from beginning"
fi

# Start replay
$REPLAY_CMD

# Monitor replay progress
echo "Monitoring replay progress..."
LAST_EVENTS_PROCESSED=0
STALL_COUNT=0

while true; do
  REPLAY_STATUS=$(caracal replay status --format json)
  REPLAY_STATE=$(echo "$REPLAY_STATUS" | jq -r '.state')
  EVENTS_PROCESSED=$(echo "$REPLAY_STATUS" | jq -r '.events_processed')
  CURRENT_OFFSET=$(echo "$REPLAY_STATUS" | jq -r '.current_offset')
  
  # Calculate events per second
  EVENTS_DELTA=$((EVENTS_PROCESSED - LAST_EVENTS_PROCESSED))
  LAST_EVENTS_PROCESSED=$EVENTS_PROCESSED
  
  echo "  State: $REPLAY_STATE, Events: $EVENTS_PROCESSED, Offset: $CURRENT_OFFSET, Rate: ${EVENTS_DELTA}/5s"
  
  # Check for stall
  if [ "$EVENTS_DELTA" -eq 0 ]; then
    STALL_COUNT=$((STALL_COUNT + 1))
    
    if [ "$STALL_COUNT" -ge 6 ]; then
      echo "WARNING: Replay appears to be stalled (no progress for 30s)"
      echo "This may be normal if all events have been replayed"
    fi
  else
    STALL_COUNT=0
  fi
  
  if [ "$REPLAY_STATE" = "completed" ]; then
    break
  elif [ "$REPLAY_STATE" = "failed" ]; then
    echo "ERROR: Replay failed"
    exit 1
  fi
  
  sleep 5
done

REPLAY_END_TIME=$(date +%s)
REPLAY_DURATION=$((REPLAY_END_TIME - REPLAY_START_TIME))

echo "Event replay completed successfully in ${REPLAY_DURATION}s"
echo "Events replayed: $EVENTS_PROCESSED"

# Calculate replay rate
if [ "$REPLAY_DURATION" -gt 0 ]; then
  REPLAY_RATE=$((EVENTS_PROCESSED / REPLAY_DURATION))
  echo "Average replay rate: ${REPLAY_RATE} events/sec"
fi

# Step 4: Verify ledger integrity
if [ "$VERIFY_INTEGRITY" = "true" ]; then
  echo ""
  echo "Step 4: Verifying ledger integrity..."
  
  VERIFY_START_TIME=$(date +%s)
  
  # Verify all batches
  VERIFY_RESULT=$(caracal merkle verify-range \
    --start-time "1970-01-01T00:00:00Z" \
    --end-time "now" \
    --format json)
  
  VERIFY_END_TIME=$(date +%s)
  VERIFY_DURATION=$((VERIFY_END_TIME - VERIFY_START_TIME))
  
  BATCHES_VERIFIED=$(echo "$VERIFY_RESULT" | jq -r '.batches_verified')
  BATCHES_PASSED=$(echo "$VERIFY_RESULT" | jq -r '.batches_passed')
  BATCHES_FAILED=$(echo "$VERIFY_RESULT" | jq -r '.batches_failed')
  
  echo "Batches verified: $BATCHES_VERIFIED"
  echo "Batches passed: $BATCHES_PASSED"
  echo "Batches failed: $BATCHES_FAILED"
  echo "Verification duration: ${VERIFY_DURATION}s"
  
  if [ "$BATCHES_FAILED" -gt 0 ]; then
    echo "ERROR: Integrity verification failed"
    echo "Some batches failed verification - investigate before restarting consumers"
    exit 1
  fi
  
  echo "Integrity verification: PASSED"
fi

# Step 5: Restart consumers
echo ""
echo "Step 5: Restarting Kafka consumers..."
if [ "$KUBERNETES" = "true" ]; then
  kubectl scale deployment/caracal-ledger-writer -n "$NAMESPACE" --replicas=3
  kubectl scale deployment/caracal-metrics-aggregator -n "$NAMESPACE" --replicas=2
  kubectl scale deployment/caracal-audit-logger -n "$NAMESPACE" --replicas=1
  
  echo "Consumers restarted"
else
  echo "WARNING: Not running in Kubernetes, please restart consumers manually"
fi

# Summary
TOTAL_DURATION=$(($(date +%s) - REPLAY_START_TIME))

echo ""
echo "=========================================="
echo "Recovery completed successfully"
echo "=========================================="
echo "Events replayed: $EVENTS_PROCESSED"
if [ "$REPLAY_DURATION" -gt 0 ]; then
  echo "Average replay rate: ${REPLAY_RATE} events/sec"
fi
if [ "$VERIFY_INTEGRITY" = "true" ]; then
  echo "Batches verified: $BATCHES_VERIFIED"
  echo "Integrity: PASSED"
fi
echo "Total duration: ${TOTAL_DURATION}s"
echo "=========================================="

exit 0
