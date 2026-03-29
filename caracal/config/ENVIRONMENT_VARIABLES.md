# Caracal Core Environment Variables

This document lists all environment variables that can be used in Caracal Core v0.2 configuration files.

## Overview

Caracal Core supports environment variable substitution in YAML configuration files using the `${ENV_VAR}` syntax. You can also provide default values using `${ENV_VAR:default}`.

### Examples

```yaml
database:
  host: ${DATABASE_HOST:localhost}
  port: ${DATABASE_PORT:5432}
  password: ${DATABASE_PASSWORD}
```

## Database Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DATABASE_HOST` | PostgreSQL server hostname | localhost | No |
| `DATABASE_PORT` | PostgreSQL server port | 5432 | No |
| `DATABASE_NAME` | Database name | caracal | No |
| `DATABASE_USER` | Database username | caracal | No |
| `DATABASE_PASSWORD` | Database password | (empty) | No |
| `DATABASE_POOL_SIZE` | Connection pool size | 10 | No |
| `DATABASE_MAX_OVERFLOW` | Max overflow connections | 5 | No |
| `DATABASE_POOL_TIMEOUT` | Pool timeout in seconds | 30 | No |

## External Enterprise Connection

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `CARACAL_ENTERPRISE_URL` | Hosted enterprise endpoint URL | (empty) | No |
| `CARACAL_ENTERPRISE_DEV_URL` | Dev-only local enterprise override URL | (empty) | No |
| `CARACAL_GATEWAY_ENABLED` | Enable enterprise gateway enforcement | false | No |
| `CARACAL_GATEWAY_ENDPOINT` | Legacy endpoint alias (compatibility) | (empty) | No |
| `CARACAL_GATEWAY_URL` | Legacy URL alias (compatibility) | (empty) | No |

## Policy Cache Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `POLICY_CACHE_ENABLED` | Enable policy cache | true | No |
| `POLICY_CACHE_TTL_SECONDS` | Cache TTL in seconds | 60 | No |
| `POLICY_CACHE_MAX_SIZE` | Maximum cache size | 10000 | No |

## MCP Adapter Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_ADAPTER_ENABLED` | Enable MCP adapter | false | No |
| `MCP_ADAPTER_LISTEN_ADDRESS` | MCP adapter listen address | 0.0.0.0:8080 | No |
| `MCP_ADAPTER_HEALTH_CHECK_ENABLED` | Enable health check endpoint | true | No |

## Storage Configuration (v0.1 compatibility)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `CARACAL_HOME` | Primary storage root for keystore/workspaces/ledger/system domains | `~/.caracal` | Recommended |
| `CARACAL_AGENT_REGISTRY` | Path to agents.json | ~/.caracal/agents.json | No |
| `CARACAL_POLICY_STORE` | Path to policies.json | ~/.caracal/policies.json | No |
| `CARACAL_LEDGER` | Path to ledger.jsonl | ~/.caracal/ledger.jsonl | No |

| `CARACAL_BACKUP_DIR` | Path to backup directory | ~/.caracal/backups | No |

## Logging Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `LOG_LEVEL` | Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL) | INFO | No |
| `LOG_FILE` | Path to log file | ~/.caracal/caracal.log | No |
| `CARACAL_ENV_MODE` | Runtime mode (`dev`, `staging`, `prod`) | dev | No |
| `CARACAL_DEBUG_LOGS` | Enable debug logs (effective only in `dev`) | false | No |
| `CARACAL_JSON_LOGS` | Force JSON logs in `dev` mode | false | No |

## Principal Key Storage

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `CARACAL_PRINCIPAL_KEY_BACKEND` | Principal key backend (`local` or `aws_kms`) | local | No |
| `CARACAL_KEYSTORE_DIR` | Local directory for principal private keys | `${CARACAL_HOME}/keystore/principals` | No |
| `CARACAL_AWS_KMS_KEY_ID` | AWS KMS key ID/ARN for principal key encryption | - | No |
| `CARACAL_AWS_KMS_REGION` | AWS region for KMS client | `AWS_REGION` | No |

## Vault Master Key

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `CARACAL_VAULT_MEK_SECRET` | Root secret used to derive Starter-tier CaracalVault MEKs (must be strong random) | - | Yes (when using CaracalVault) |

## Config Encryption Key Management

- Config encryption no longer requires `CARACAL_MASTER_PASSWORD`.
- Caracal generates a 32-byte master key at `${CARACAL_HOME}/keystore/master_key`.
- Installation salt is stored at `${CARACAL_HOME}/keystore/salt.bin`.
- DEKs are stored wrapped under `${CARACAL_HOME}/keystore/encrypted_keys/`.
- Master key lifecycle events are appended at `${CARACAL_HOME}/ledger/audit_logs/key_events.jsonl`.

### Runtime Mode Logging Rules

- `dev`: human-readable logs by default; DEBUG allowed only when `CARACAL_DEBUG_LOGS=true`.
- `staging`: JSON logs with sensitive-field redaction; DEBUG automatically downgraded.
- `prod`: JSON logs with sensitive-field redaction; DEBUG automatically downgraded.

## Example Configuration File

```yaml
# config.yaml with environment variable substitution

database:
  host: ${DATABASE_HOST:localhost}
  port: ${DATABASE_PORT:5432}
  database: ${DATABASE_NAME:caracal}
  user: ${DATABASE_USER:caracal}
  password: ${DATABASE_PASSWORD}
  pool_size: ${DATABASE_POOL_SIZE:10}
  max_overflow: ${DATABASE_MAX_OVERFLOW:5}
  pool_timeout: ${DATABASE_POOL_TIMEOUT:30}

gateway:
  enabled: ${CARACAL_GATEWAY_ENABLED:false}
  endpoint: ${CARACAL_ENTERPRISE_URL:${CARACAL_GATEWAY_ENDPOINT:${CARACAL_GATEWAY_URL}}}

policy_cache:
  enabled: ${POLICY_CACHE_ENABLED:true}
  ttl_seconds: ${POLICY_CACHE_TTL_SECONDS:60}
  max_size: ${POLICY_CACHE_MAX_SIZE:10000}

mcp_adapter:
  enabled: ${MCP_ADAPTER_ENABLED:false}
  listen_address: ${MCP_ADAPTER_LISTEN_ADDRESS:0.0.0.0:8080}
  health_check_enabled: ${MCP_ADAPTER_HEALTH_CHECK_ENABLED:true}

logging:
  level: ${LOG_LEVEL:INFO}
  file: ${LOG_FILE:${CARACAL_HOME:~/.caracal}/logs/caracal.log}

storage:
  principal_registry: ${CARACAL_AGENT_REGISTRY:${CARACAL_HOME:~/.caracal}/agents.json}
  policy_store: ${CARACAL_POLICY_STORE:${CARACAL_HOME:~/.caracal}/policies.json}
  ledger: ${CARACAL_LEDGER:${CARACAL_HOME:~/.caracal}/ledger.jsonl}

  backup_dir: ${CARACAL_BACKUP_DIR:${CARACAL_HOME:~/.caracal}/backups}
```

## Environment Variable Precedence

Environment variables are resolved in the following order:

1. **Actual environment variable value** - If the environment variable is set, its value is used
2. **Default value in config** - If the environment variable is not set and a default is provided (e.g., `${VAR:default}`), the default is used
3. **Empty string** - If the environment variable is not set and no default is provided, an empty string is used

## Security Considerations

- **Never commit sensitive values** (passwords, API keys, certificates) to version control
- **Use environment variables** for all sensitive configuration values
- **Restrict file permissions** on configuration files containing sensitive data
- **Use secrets management** (e.g., Kubernetes Secrets, AWS Secrets Manager) in production
- **Rotate credentials regularly** and update environment variables accordingly

## Docker and Kubernetes Deployment

### Docker

Pass environment variables using the `-e` flag:

```bash
docker run -e DATABASE_PASSWORD=secret \
           -e GATEWAY_TLS_CERT_FILE=/certs/server.crt \
           caracal-core:latest
```

### Kubernetes

Use ConfigMaps for non-sensitive values and Secrets for sensitive values:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: caracal-config
data:
  DATABASE_HOST: "postgres.default.svc.cluster.local"
  DATABASE_PORT: "5432"
  GATEWAY_ENABLED: "true"
---
apiVersion: v1
kind: Secret
metadata:
  name: caracal-secrets
type: Opaque
stringData:
  DATABASE_PASSWORD: "secret"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: caracal-gateway
spec:
  template:
    spec:
      containers:
      - name: caracal
        image: caracal-core:latest
        envFrom:
        - configMapRef:
            name: caracal-config
        - secretRef:
            name: caracal-secrets
```
