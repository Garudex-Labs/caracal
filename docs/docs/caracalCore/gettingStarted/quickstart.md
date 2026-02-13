---
sidebar_position: 2
title: Quickstart Guide
---

# Docker Quickstart Guide

Get the Caracal Gateway Proxy running in 5 minutes.

## Prerequisites

- Docker 20.10+
- Docker Compose 1.29+
- 2GB RAM minimum

## Quick Start (Development)

### 1. Clone and Navigate

```bash
cd Caracal
```

### 2. Create Environment File

```bash
cp .env.gateway.example .env
```

Edit `.env` and set a secure password:

```bash
DB_PASSWORD=your_secure_password_here
```

### 3. Build and Start

```bash
docker build -f Dockerfile.gateway -t caracal-gateway:latest .
docker-compose -f docker-compose.gateway.yml up -d
```

### 4. Verify

```bash
curl http://localhost:8443/health
docker-compose -f docker-compose.gateway.yml logs -f gateway
```

---

## Initialize and Test

### Initialize Database

```bash
docker-compose -f docker-compose.gateway.yml exec gateway caracal db migrate up
```

### Register a Principal

```bash
docker-compose -f docker-compose.gateway.yml exec gateway caracal agent register \
  --name test-agent \
  --owner admin
```

### Create an Authority Policy

```bash
docker-compose -f docker-compose.gateway.yml exec gateway caracal policy create \
  --agent-name test-agent \
  --resources "api:*" \
  --actions "read" "write" \
  --max-validity 86400
```

---

<details>
<summary>Production setup with TLS</summary>

### Prepare TLS Certificates

```bash
mkdir -p certs
```

Required files:
- `certs/server.crt` -- Server TLS certificate
- `certs/server.key` -- Server TLS private key
- `certs/ca.crt` -- CA certificate (for mTLS)
- `certs/jwt_public.pem` -- JWT public key

### Generate Self-Signed Certificates (Development Only)

```bash
# Generate CA
openssl req -x509 -newkey rsa:4096 -keyout certs/ca.key \
  -out certs/ca.crt -days 365 -nodes -subj "/CN=Caracal CA"

# Generate server certificate
openssl req -newkey rsa:4096 -keyout certs/server.key \
  -out certs/server.csr -nodes -subj "/CN=localhost"
openssl x509 -req -in certs/server.csr -CA certs/ca.crt \
  -CAkey certs/ca.key -CAcreateserial -out certs/server.crt -days 365

# Generate JWT key pair
openssl genrsa -out certs/jwt_private.pem 4096
openssl rsa -in certs/jwt_private.pem -pubout -out certs/jwt_public.pem

chmod 600 certs/*.key certs/*.pem
```

### Verify TLS

```bash
curl -k https://localhost:8443/health
curl http://localhost:9090/metrics
```

</details>

---

<details>
<summary>Testing with JWT tokens</summary>

### Generate JWT Token

```python
# test_jwt.py
import jwt
from datetime import datetime, timedelta

with open('certs/jwt_private.pem', 'r') as f:
    private_key = f.read()

payload = {
    'iss': 'caracal-core',
    'sub': 'test-principal-id',
    'aud': 'caracal-gateway',
    'exp': datetime.utcnow() + timedelta(hours=1),
    'iat': datetime.utcnow(),
    'principal_id': 'test-principal-id'
}

token = jwt.encode(payload, private_key, algorithm='RS256')
print(token)
```

### Make Request Through Gateway

```bash
TOKEN="your-jwt-token-here"

curl -k -X POST https://localhost:8443/api/test \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Caracal-Target-URL: https://httpbin.org/post" \
  -H "X-Caracal-Nonce: $(uuidgen)" \
  -H "X-Caracal-Timestamp: $(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

</details>

---

## Monitoring

```bash
# Gateway logs
docker-compose -f docker-compose.gateway.yml logs -f gateway

# Prometheus metrics
curl http://localhost:9090/metrics

# Health endpoint
curl http://localhost:8443/health | jq
```

---

## Common Commands

```bash
docker-compose -f docker-compose.gateway.yml up -d       # Start
docker-compose -f docker-compose.gateway.yml down         # Stop
docker-compose -f docker-compose.gateway.yml restart gateway  # Restart
docker-compose -f docker-compose.gateway.yml logs -f      # Logs
docker-compose -f docker-compose.gateway.yml down -v      # Clean up
```

---

<details>
<summary>Troubleshooting</summary>

### Gateway won't start

```bash
docker-compose -f docker-compose.gateway.yml logs gateway
# Common: Database not ready, TLS cert missing, JWT key missing
```

### Database connection failed

```bash
docker-compose -f docker-compose.gateway.yml ps postgres
docker-compose -f docker-compose.gateway.yml exec postgres \
  psql -U caracal -d caracal -c "SELECT 1"
```

### Port already in use

```bash
# Change ports in .env
GATEWAY_PORT=8444
METRICS_PORT=9091
```

</details>

<details>
<summary>Performance tuning</summary>

```bash
# .env
DB_POOL_SIZE=20
DB_MAX_OVERFLOW=10
POLICY_CACHE_MAX_SIZE=50000
POLICY_CACHE_TTL=120
```

Scale gateway instances:

```bash
docker-compose -f docker-compose.gateway.yml up -d --scale gateway=3
```

</details>

---

## Next Steps

1. [Production Deployment](../deployment/production) -- Full production setup
2. [Kubernetes](../deployment/kubernetes) -- Container orchestration
3. [SDK Reference](../apiReference/sdkClient) -- Integrate authority checks into your code
