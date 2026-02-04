---
sidebar_position: 1
title: Docker Compose Deployment
---

# Docker Compose Deployment

This guide covers deploying Caracal Core using Docker Compose with PostgreSQL, Gateway Proxy, and MCP Adapter services.

## Prerequisites

- Docker 20.10+ and Docker Compose 1.29+
- At least 4GB RAM available for containers
- TLS certificates for gateway proxy

## Quick Start

### 1. Clone and Navigate

```bash
git clone https://github.com/Garudex-Labs/Caracal.git
cd Caracal
```

### 2. Create Environment File

```bash
cp .env.example .env
```

Edit `.env` and set your configuration:

```bash
# Change the database password in production
DB_PASSWORD=your_secure_password_here

# Configure authentication mode (mtls, jwt, or api_key)
AUTH_MODE=jwt

# Optional: Configure MCP servers
MCP_SERVERS=local:http://localhost:3000
```

### 3. Certificate Setup

Create a `certs` directory with TLS certificates:

```bash
mkdir -p certs
```

**Development (Self-Signed):**

```bash
# Generate CA certificate
openssl req -x509 -newkey rsa:4096 -keyout certs/ca.key -out certs/ca.crt \
  -days 365 -nodes -subj "/CN=Caracal CA"

# Generate server certificate
openssl req -newkey rsa:4096 -keyout certs/server.key -out certs/server.csr \
  -nodes -subj "/CN=localhost"

openssl x509 -req -in certs/server.csr -CA certs/ca.crt -CAkey certs/ca.key \
  -CAcreateserial -out certs/server.crt -days 365

# Generate JWT key pair
openssl genrsa -out certs/jwt_private.pem 4096
openssl rsa -in certs/jwt_private.pem -pubout -out certs/jwt_public.pem

rm certs/server.csr
```

**Production:** Copy your production certificates to the `certs` directory.

### 4. Start Services

```bash
docker-compose up -d
docker-compose logs -f
```

### 5. Initialize Database

```bash
docker-compose exec postgres pg_isready -U caracal
docker-compose exec gateway caracal db init
```

### 6. Verify Services

```bash
docker-compose ps
curl -k https://localhost:8443/health
curl http://localhost:8080/health
```

## Service Endpoints

| Service | URL | Description |
|---------|-----|-------------|
| Gateway HTTPS | `https://localhost:8443` | Main API gateway |
| Gateway Health | `https://localhost:8443/health` | Health check |
| MCP Adapter | `http://localhost:8080` | MCP protocol adapter |
| Prometheus | `http://localhost:9090/metrics` | Metrics endpoint |
| PostgreSQL | `localhost:5432` | Database |

## Common Commands

### Service Management

```bash
docker-compose up -d          # Start services
docker-compose stop           # Stop services
docker-compose down           # Remove containers
docker-compose down -v        # Remove containers and volumes
docker-compose restart        # Restart all services
```

### Logs and Debugging

```bash
docker-compose logs -f                    # All logs
docker-compose logs -f gateway            # Gateway logs
docker-compose logs --tail=100 gateway    # Last 100 lines
```

### CLI Commands

```bash
docker-compose exec gateway caracal agent list
docker-compose exec gateway caracal policy list
docker-compose exec gateway caracal ledger summary
```

### Database Operations

```bash
# Access database
docker-compose exec postgres psql -U caracal -d caracal

# Backup
docker-compose exec postgres pg_dump -U caracal caracal > backup.sql

# Restore
docker-compose exec -T postgres psql -U caracal caracal < backup.sql
```

## Troubleshooting

### Services Won't Start

1. Check Docker versions: `docker --version && docker-compose --version`
2. Check logs: `docker-compose logs`
3. Verify config: `docker-compose config`

### Database Connection Errors

1. Verify PostgreSQL is running: `docker-compose ps postgres`
2. Check health: `docker-compose exec postgres pg_isready -U caracal`
3. Review credentials in `.env`

### TLS Certificate Errors

1. Verify certificates exist: `ls -la certs/`
2. Check validity: `openssl x509 -in certs/server.crt -text -noout`

## Production Checklist

- [ ] Change default database password
- [ ] Use production TLS certificates
- [ ] Configure firewall rules
- [ ] Enable mTLS authentication
- [ ] Set up log aggregation
- [ ] Configure backup strategy
- [ ] Review resource limits
- [ ] Set up alerting

## Next Steps

- [Kubernetes Deployment](./kubernetes) - Deploy on Kubernetes
- [Production Guide](./production) - Advanced production settings
- [Operational Runbook](./operationalRunbook) - Operations procedures
