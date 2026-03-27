#!/bin/bash
#
# PostgreSQL Backup Script for Caracal Core
#
# This script creates a backup of the PostgreSQL database and optionally
# uploads it to S3 for long-term storage.
#
# Usage:
#   ./backup-postgresql.sh [options]
#
# Options:
#   --backup-dir DIR    Directory to store backups (default: /backups/postgresql)
#   --retention-days N  Number of days to retain backups (default: 30)
#   --s3-bucket BUCKET  S3 bucket for backup storage (optional)
#   --s3-prefix PREFIX  S3 prefix for backups (default: postgresql/)
#   --compress          Compress backup with gzip (default: true)
#   --kubernetes        Use kubectl to access PostgreSQL pod (default: false)
#   --pod-name NAME     PostgreSQL pod name (default: postgresql-0)
#   --namespace NS      Kubernetes namespace (default: caracal)
#   --db-host HOST      PostgreSQL host (default: localhost)
#   --db-port PORT      PostgreSQL port (default: 5432)
#   --db-name NAME      Database name (default: caracal)
#   --db-user USER      Database user (default: caracal)
#
# Requirements: Deployment

set -euo pipefail

# Default configuration
BACKUP_DIR="${BACKUP_DIR:-/backups/postgresql}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
S3_BUCKET="${S3_BUCKET:-}"
S3_PREFIX="${S3_PREFIX:-postgresql/}"
COMPRESS="${COMPRESS:-true}"
KUBERNETES="${KUBERNETES:-false}"
POD_NAME="${POD_NAME:-postgresql-0}"
NAMESPACE="${NAMESPACE:-caracal}"
DB_HOST="${CARACAL_DB_HOST:-localhost}"
DB_PORT="${CARACAL_DB_PORT:-5432}"
DB_NAME="${CARACAL_DB_NAME:-caracal}"
DB_USER="${CARACAL_DB_USER:-caracal}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --backup-dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    --retention-days)
      RETENTION_DAYS="$2"
      shift 2
      ;;
    --s3-bucket)
      S3_BUCKET="$2"
      shift 2
      ;;
    --s3-prefix)
      S3_PREFIX="$2"
      shift 2
      ;;
    --compress)
      COMPRESS="true"
      shift
      ;;
    --no-compress)
      COMPRESS="false"
      shift
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
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Generate timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Generate backup filename
if [ "$COMPRESS" = "true" ]; then
  BACKUP_FILE="$BACKUP_DIR/caracal_backup_$TIMESTAMP.sql.gz"
else
  BACKUP_FILE="$BACKUP_DIR/caracal_backup_$TIMESTAMP.sql"
fi

echo "=========================================="
echo "Caracal PostgreSQL Backup"
echo "=========================================="
echo "Timestamp: $TIMESTAMP"
echo "Backup file: $BACKUP_FILE"
echo "Database: $DB_NAME"
echo "Compress: $COMPRESS"
echo "Kubernetes: $KUBERNETES"
echo "=========================================="

# Create backup
echo "Creating backup..."
START_TIME=$(date +%s)

if [ "$KUBERNETES" = "true" ]; then
  # Backup from Kubernetes pod
  echo "Backing up from Kubernetes pod: $POD_NAME (namespace: $NAMESPACE)"
  
  if [ "$COMPRESS" = "true" ]; then
    kubectl exec -n "$NAMESPACE" "$POD_NAME" -- \
      pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_FILE"
  else
    kubectl exec -n "$NAMESPACE" "$POD_NAME" -- \
      pg_dump -U "$DB_USER" "$DB_NAME" > "$BACKUP_FILE"
  fi
else
  # Backup from direct connection
  echo "Backing up from host: $DB_HOST:$DB_PORT"
  
  if [ "$COMPRESS" = "true" ]; then
    PGPASSWORD="${PGPASSWORD:-}" pg_dump \
      -h "$DB_HOST" \
      -p "$DB_PORT" \
      -U "$DB_USER" \
      "$DB_NAME" | gzip > "$BACKUP_FILE"
  else
    PGPASSWORD="${PGPASSWORD:-}" pg_dump \
      -h "$DB_HOST" \
      -p "$DB_PORT" \
      -U "$DB_USER" \
      "$DB_NAME" > "$BACKUP_FILE"
  fi
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "Backup created successfully in ${DURATION}s"

# Verify backup
echo "Verifying backup..."
if [ "$COMPRESS" = "true" ]; then
  if gunzip -t "$BACKUP_FILE" 2>/dev/null; then
    echo "Backup verification: PASSED"
  else
    echo "Backup verification: FAILED"
    exit 1
  fi
else
  if [ -f "$BACKUP_FILE" ] && [ -s "$BACKUP_FILE" ]; then
    echo "Backup verification: PASSED"
  else
    echo "Backup verification: FAILED"
    exit 1
  fi
fi

# Get backup size
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Backup size: $BACKUP_SIZE"

# Upload to S3 if configured
if [ -n "$S3_BUCKET" ]; then
  echo "Uploading backup to S3..."
  S3_PATH="s3://$S3_BUCKET/$S3_PREFIX$(basename "$BACKUP_FILE")"
  
  if command -v aws &> /dev/null; then
    aws s3 cp "$BACKUP_FILE" "$S3_PATH"
    echo "Backup uploaded to: $S3_PATH"
  else
    echo "WARNING: aws CLI not found, skipping S3 upload"
  fi
fi

# Cleanup old backups
echo "Cleaning up old backups (retention: $RETENTION_DAYS days)..."
DELETED_COUNT=$(find "$BACKUP_DIR" -name "caracal_backup_*.sql*" -mtime +$RETENTION_DAYS -delete -print | wc -l)
echo "Deleted $DELETED_COUNT old backup(s)"

# Summary
echo "=========================================="
echo "Backup completed successfully"
echo "=========================================="
echo "Backup file: $BACKUP_FILE"
echo "Backup size: $BACKUP_SIZE"
echo "Duration: ${DURATION}s"
if [ -n "$S3_BUCKET" ]; then
  echo "S3 location: $S3_PATH"
fi
echo "=========================================="

exit 0
