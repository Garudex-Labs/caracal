---
sidebar_position: 2
title: Quickstart Guide
---

# Docker Quickstart Guide

Get the Caracal Gateway Proxy running in 5 minutes!

## Prerequisites

- Docker 20.10+
- Docker Compose 1.29+
- 2GB RAM minimum
- TLS certificates (for production) or use without TLS for development

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
# Build the gateway image
docker build -f Dockerfile.gateway -t caracal-gateway:latest .

# Start services
docker-compose -f docker-compose.gateway.yml up -d
```

### 4. Verify

```bash
# Check health
curl http://localhost:8443/health

# Check logs
docker-compose -f docker-compose.gateway.yml logs -f gateway
```

## Quick Start (Production with TLS)

### 1. Prepare TLS Certificates

Create a `certs` directory with your certificates:

```bash
mkdir -p certs
```

Required files:
- `certs/server.crt` - Server TLS certificate
- `certs/server.key` - Server TLS private key
- `certs/ca.crt` - CA certificate (for mTLS)
- `certs/jwt_public.pem` - JWT public key (for JWT auth)

### 2. Generate Self-Signed Certificates (Development Only)

```bash
# Generate CA
openssl req -x509 -newkey rsa:4096 -keyout certs/ca.key -out certs/ca.crt -days 365 -nodes -subj "/CN=Caracal CA"

# Generate server certificate
openssl req -newkey rsa:4096 -keyout certs/server.key -out certs/server.csr -nodes -subj "/CN=localhost"
openssl x509 -req -in certs/server.csr -CA certs/ca.crt -CAkey certs/ca.key -CAcreateserial -out certs/server.crt -days 365

# Generate JWT key pair
openssl genrsa -out certs/jwt_private.pem 4096
openssl rsa -in certs/jwt_private.pem -pubout -out certs/jwt_public.pem

# Set permissions
chmod 600 certs/*.key certs/*.pem
```

### 3. Configure and Start

```bash
# Set environment
cp .env.gateway.example .env
# Edit .env with your settings

# Build and start
docker build -f Dockerfile.gateway -t caracal-gateway:latest .
docker-compose -f docker-compose.gateway.yml up -d
```

### 4. Verify TLS

```bash
# Check health (HTTPS)
curl -k https://localhost:8443/health

# Check metrics
curl http://localhost:9090/metrics
```

## Initialize Database

Before using the gateway, initialize the database schema:

```bash
# Run migrations (if using Alembic)
docker-compose -f docker-compose.gateway.yml exec gateway caracal db migrate up

# Or initialize directly
docker-compose -f docker-compose.gateway.yml exec gateway caracal init-db
```

## Create Test Agent

```bash
# Register an agent
docker-compose -f docker-compose.gateway.yml exec gateway caracal agent register \
  --name test-agent \
  --owner admin

# Create a policy
docker-compose -f docker-compose.gateway.yml exec gateway caracal policy create \
  --agent-name test-agent \
  --limit 100.00 \
  --time-window daily
```

## Test Request

### Generate JWT Token (for testing)

```python
# test_jwt.py
import jwt
from datetime import datetime, timedelta

# Load private key
with open('certs/jwt_private.pem', 'r') as f:
    private_key = f.read()

# Create token
payload = {
    'iss': 'caracal-core',
    'sub': 'test-agent-id',
    'aud': 'caracal-gateway',
    'exp': datetime.utcnow() + timedelta(hours=1),
    'iat': datetime.utcnow(),
    'agent_id': 'test-agent-id'
}

token = jwt.encode(payload, private_key, algorithm='RS256')
print(token)
```

### Make Request Through Gateway

```bash
# Set your JWT token
TOKEN="your-jwt-token-here"

# Make request
curl -k -X POST https://localhost:8443/api/test \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Caracal-Target-URL: https://httpbin.org/post" \
  -H "X-Caracal-Nonce: $(uuidgen)" \
  -H "X-Caracal-Timestamp: $(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

## Monitoring

### View Logs

```bash
# Gateway logs
docker-compose -f docker-compose.gateway.yml logs -f gateway

# Database logs
docker-compose -f docker-compose.gateway.yml logs -f postgres
```

### Check Metrics

```bash
# Prometheus metrics
curl http://localhost:9090/metrics

# Gateway statistics
curl http://localhost:8443/stats
```

### Health Check

```bash
# Health endpoint
curl http://localhost:8443/health | jq

# Expected output:
# {
#   "status": "healthy",
#   "service": "caracal-gateway-proxy",
#   "version": "0.4.0",
#   "checks": {
#     "database": "healthy",
#     "policy_cache": {
#       "status": "enabled",
#       "size": 0,
#       "max_size": 10000,
#       "hit_rate": 0.0
#     }
#   }
# }
```

## Common Commands

```bash
# Start services
docker-compose -f docker-compose.gateway.yml up -d

# Stop services
docker-compose -f docker-compose.gateway.yml down

# Restart gateway
docker-compose -f docker-compose.gateway.yml restart gateway

# View logs
docker-compose -f docker-compose.gateway.yml logs -f

# Execute command in gateway container
docker-compose -f docker-compose.gateway.yml exec gateway caracal --help

# Access database
docker-compose -f docker-compose.gateway.yml exec postgres psql -U caracal -d caracal

# Rebuild gateway image
docker-compose -f docker-compose.gateway.yml build gateway

# Clean up everything (including volumes)
docker-compose -f docker-compose.gateway.yml down -v
```

## Troubleshooting

### Gateway won't start

```bash
# Check logs
docker-compose -f docker-compose.gateway.yml logs gateway

# Common issues:
# - Database not ready: Wait for postgres to be healthy
# - TLS cert not found: Check certs/ directory
# - JWT key not found: Generate JWT keys
```

### Database connection failed

```bash
# Check postgres is running
docker-compose -f docker-compose.gateway.yml ps postgres

# Check postgres logs
docker-compose -f docker-compose.gateway.yml logs postgres

# Test connection
docker-compose -f docker-compose.gateway.yml exec postgres psql -U caracal -d caracal -c "SELECT 1"
```

### Authentication failures

```bash
# Check JWT token is valid
# Verify JWT public key matches private key used to sign tokens
# Check token expiration

# View gateway logs for auth errors
docker-compose -f docker-compose.gateway.yml logs gateway | grep -i auth
```

### Port already in use

```bash
# Change ports in .env
GATEWAY_PORT=8444
METRICS_PORT=9091

# Or stop conflicting service
sudo lsof -i :8443
```

## Performance Tuning

### Increase Database Pool

Edit `.env`:
```bash
DB_POOL_SIZE=20
DB_MAX_OVERFLOW=10
```

### Increase Policy Cache

Edit `.env`:
```bash
POLICY_CACHE_MAX_SIZE=50000
POLICY_CACHE_TTL=120
```

### Scale Gateway Instances

```bash
# Scale to 3 instances
docker-compose -f docker-compose.gateway.yml up -d --scale gateway=3

# Use nginx or HAProxy for load balancing
```

## Next Steps

1. **Production Deployment**: See `DOCKER_GATEWAY.md` for detailed production setup
2. **Kubernetes**: See `KUBERNETES.md` for Kubernetes deployment
3. **Monitoring**: Set up Prometheus and Grafana for metrics
4. **Security**: Configure mTLS, rotate credentials, enable audit logging
5. **Scaling**: Deploy multiple gateway instances with load balancer

## Support

- Documentation: `DOCKER_GATEWAY.md`
- GitHub: https://github.com/Garudex-Labs/caracal
- Issues: https://github.com/Garudex-Labs/caracal/issues
