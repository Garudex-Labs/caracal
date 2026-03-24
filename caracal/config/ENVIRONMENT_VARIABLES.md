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

## Gateway Proxy Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `GATEWAY_ENABLED` | Enable gateway proxy | false | No |
| `GATEWAY_LISTEN_ADDRESS` | Gateway listen address | 0.0.0.0:8443 | No |
| `GATEWAY_AUTH_MODE` | Authentication mode (mtls, jwt, api_key) | mtls | No |
| `GATEWAY_TLS_ENABLED` | Enable TLS | true | No |
| `GATEWAY_TLS_CERT_FILE` | Path to TLS certificate file | (empty) | Yes if TLS enabled |
| `GATEWAY_TLS_KEY_FILE` | Path to TLS key file | (empty) | Yes if TLS enabled |
| `GATEWAY_TLS_CA_FILE` | Path to CA certificate file | (empty) | Yes if mTLS enabled |
| `GATEWAY_JWT_PUBLIC_KEY` | Path to JWT public key file | (empty) | Yes if JWT auth |
| `GATEWAY_REPLAY_PROTECTION_ENABLED` | Enable replay protection | true | No |
| `GATEWAY_NONCE_CACHE_TTL` | Nonce cache TTL in seconds | 300 | No |

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
| `CARACAL_AGENT_REGISTRY` | Path to agents.json | ~/.caracal/agents.json | No |
| `CARACAL_POLICY_STORE` | Path to policies.json | ~/.caracal/policies.json | No |
| `CARACAL_LEDGER` | Path to ledger.jsonl | ~/.caracal/ledger.jsonl | No |

| `CARACAL_BACKUP_DIR` | Path to backup directory | ~/.caracal/backups | No |

## Logging Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `LOG_LEVEL` | Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL) | INFO | No |
| `LOG_FILE` | Path to log file | ~/.caracal/caracal.log | No |

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
  enabled: ${GATEWAY_ENABLED:false}
  listen_address: ${GATEWAY_LISTEN_ADDRESS:0.0.0.0:8443}
  auth_mode: ${GATEWAY_AUTH_MODE:mtls}
  tls:
    enabled: ${GATEWAY_TLS_ENABLED:true}
    cert_file: ${GATEWAY_TLS_CERT_FILE}
    key_file: ${GATEWAY_TLS_KEY_FILE}
    ca_file: ${GATEWAY_TLS_CA_FILE}
  jwt_public_key: ${GATEWAY_JWT_PUBLIC_KEY}
  replay_protection_enabled: ${GATEWAY_REPLAY_PROTECTION_ENABLED:true}
  nonce_cache_ttl: ${GATEWAY_NONCE_CACHE_TTL:300}

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
  file: ${LOG_FILE:~/.caracal/caracal.log}

storage:
  agent_registry: ${CARACAL_AGENT_REGISTRY:~/.caracal/agents.json}
  policy_store: ${CARACAL_POLICY_STORE:~/.caracal/policies.json}
  ledger: ${CARACAL_LEDGER:~/.caracal/ledger.jsonl}

  backup_dir: ${CARACAL_BACKUP_DIR:~/.caracal/backups}
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
