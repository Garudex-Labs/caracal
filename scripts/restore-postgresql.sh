#!/bin/bash
#
# PostgreSQL Restore Script for Caracal Core v0.3
#
# This script restores a PostgreSQL database from a backup file.
#
# Usage:
#   ./restore-postgresql.sh --backup-file FILE [options]
#
# Options:
#   --backup-file FILE  Backup file to restore (required)
#   --s3-path PATH      S3 path to backup file (alternative to --backup-file)
#   --kubernetes        Use kubectl to access PostgreSQL pod (default: false)
#   --pod-name NAME     PostgreSQL pod name (default: postgresql-0)
#   --namespace NS      Kubernetes namespace (default: caracal)
#   --db-host HOST      PostgreSQL host (default: localhost)
#   --db-port PORT      PostgreSQL port (default: 5432)
#   --db-name NAME      Database name (default: caracal)
#   --db-user USER      Database user (default: caracal)
#   --drop-database     Drop database before restore (default: false)

#   --confirm           Skip confirmation prompt (default: false)
#
# Requirements: Deployment

set -euo pipefail

# Default configuration
BACKUP_FILE=""
S3_PATH=""
KUBERNETES="${KUBERNETES:-false}"
POD_NAME="${POD_NAME:-postgresql-0}"
NAMESPACE="${NAMESPACE:-caracal}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-caracal}"
DB_USER="${DB_USER:-caracal}"
DROP_DATABASE="${DROP_DATABASE:-false}"

CONFIRM="${CONFIRM:-false}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --backup-file)
      BACKUP_FILE="$2"
      shift 2
      ;;
    --s3-path)
      S3_PATH="$2"
      shift 2
      ;;
    --kubernetes)
      KUBERNETES="true"
      shift
      ;;
    --pod-name)
      POD_NAME="$2"
      shift 2
      ;;
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --db-host)
      DB_HOST="$2"
      shift 2
      ;;
    --db-port)
      DB_PORT="$2"
      shift 2
      ;;
    --db-name)
      DB_NAME="$2"
      shift 2
      ;;
    --db-user)
      DB_USER="$2"
      shift 2
      ;;
    --drop-database)
      DROP_DATABASE="true"
      shift
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

# Validate arguments
if [ -z "$BACKUP_FILE" ] && [ -z "$S3_PATH" ]; then
  echo "ERROR: Either --backup-file or --s3-path must be specified"
  exit 1
fi

# Download from S3 if needed
if [ -n "$S3_PATH" ]; then
  echo "Downloading backup from S3: $S3_PATH"
  BACKUP_FILE="/tmp/$(basename "$S3_PATH")"
  
  if command -v aws &> /dev/null; then
    aws s3 cp "$S3_PATH" "$BACKUP_FILE"
    echo "Downloaded to: $BACKUP_FILE"
  else
    echo "ERROR: aws CLI not found"
    exit 1
  fi
fi

# Verify backup file exists
if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE"
  exit 1
fi

# Detect if backup is compressed
IS_COMPRESSED=false
if [[ "$BACKUP_FILE" == *.gz ]]; then
  IS_COMPRESSED=true
fi

echo "=========================================="
echo "Caracal PostgreSQL Restore"
echo "=========================================="
echo "Backup file: $BACKUP_FILE"
echo "Database: $DB_NAME"
echo "Compressed: $IS_COMPRESSED"
echo "Kubernetes: $KUBERNETES"
echo "Drop database: $DROP_DATABASE"

echo "=========================================="

# Confirmation prompt
if [ "$CONFIRM" != "true" ]; then
  echo ""
  echo "WARNING: This will restore the database from backup."
  echo "All current data will be lost!"
  echo ""
  read -p "Are you sure you want to continue? (yes/no): " RESPONSE
  
  if [ "$RESPONSE" != "yes" ]; then
    echo "Restore cancelled"
    exit 0
  fi
fi


# Restore database
echo "Restoring database..."
START_TIME=$(date +%s)

if [ "$KUBERNETES" = "true" ]; then
  # Restore to Kubernetes pod
  echo "Restoring to Kubernetes pod: $POD_NAME (namespace: $NAMESPACE)"
  
  # Drop database if requested
  if [ "$DROP_DATABASE" = "true" ]; then
    echo "Dropping database: $DB_NAME"
    kubectl exec -n "$NAMESPACE" "$POD_NAME" -- \
      psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;"
    
    echo "Creating database: $DB_NAME"
    kubectl exec -n "$NAMESPACE" "$POD_NAME" -- \
      psql -U "$DB_USER" -d postgres -c "CREATE DATABASE $DB_NAME;"
  fi
  
  # Restore backup
  if [ "$IS_COMPRESSED" = "true" ]; then
    gunzip -c "$BACKUP_FILE" | kubectl exec -i -n "$NAMESPACE" "$POD_NAME" -- \
      psql -U "$DB_USER" "$DB_NAME"
  else
    cat "$BACKUP_FILE" | kubectl exec -i -n "$NAMESPACE" "$POD_NAME" -- \
      psql -U "$DB_USER" "$DB_NAME"
  fi
else
  # Restore to direct connection
  echo "Restoring to host: $DB_HOST:$DB_PORT"
  
  # Drop database if requested
  if [ "$DROP_DATABASE" = "true" ]; then
    echo "Dropping database: $DB_NAME"
    PGPASSWORD="${PGPASSWORD:-}" psql \
      -h "$DB_HOST" \
      -p "$DB_PORT" \
      -U "$DB_USER" \
      -d postgres \
      -c "DROP DATABASE IF EXISTS $DB_NAME;"
    
    echo "Creating database: $DB_NAME"
    PGPASSWORD="${PGPASSWORD:-}" psql \
      -h "$DB_HOST" \
      -p "$DB_PORT" \
      -U "$DB_USER" \
      -d postgres \
      -c "CREATE DATABASE $DB_NAME;"
  fi
  
  # Restore backup
  if [ "$IS_COMPRESSED" = "true" ]; then
    gunzip -c "$BACKUP_FILE" | PGPASSWORD="${PGPASSWORD:-}" psql \
      -h "$DB_HOST" \
      -p "$DB_PORT" \
      -U "$DB_USER" \
      "$DB_NAME"
  else
    PGPASSWORD="${PGPASSWORD:-}" psql \
      -h "$DB_HOST" \
      -p "$DB_PORT" \
      -U "$DB_USER" \
      "$DB_NAME" < "$BACKUP_FILE"
  fi
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "Restore completed successfully in ${DURATION}s"

# Verify restore
echo "Verifying restore..."
if [ "$KUBERNETES" = "true" ]; then
  TABLE_COUNT=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -- \
    psql -U "$DB_USER" "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")
else
  TABLE_COUNT=$(PGPASSWORD="${PGPASSWORD:-}" psql \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")
fi

echo "Tables restored: $TABLE_COUNT"

if [ "$TABLE_COUNT" -gt 0 ]; then
  echo "Restore verification: PASSED"
else
  echo "Restore verification: FAILED (no tables found)"
  exit 1
fi


# Cleanup temporary file if downloaded from S3
if [ -n "$S3_PATH" ]; then
  echo "Cleaning up temporary file..."
  rm -f "$BACKUP_FILE"
fi

# Summary
echo "=========================================="
echo "Restore completed successfully"
echo "=========================================="
echo "Database: $DB_NAME"
echo "Tables restored: $TABLE_COUNT"
echo "Duration: ${DURATION}s"
echo "=========================================="

exit 0
