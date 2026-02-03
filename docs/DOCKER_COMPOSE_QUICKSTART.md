# Caracal Core v0.2 - Docker Compose Quickstart

This guide helps you deploy Caracal Core v0.2 using Docker Compose with PostgreSQL, Gateway Proxy, and MCP Adapter services.

## Prerequisites

- Docker 20.10+ and Docker Compose 1.29+
- At least 4GB RAM available for containers
- TLS certificates for gateway proxy (see [Certificate Setup](#certificate-setup))

## Quick Start

### 1. Clone and Navigate

```bash
cd Caracal
```

### 2. Create Environment File

```bash
cp .env.example .env
```

Edit `.env` and set your configuration:

```bash
# IMPORTANT: Change the database password in production!
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

#### Option A: Self-Signed Certificates (Development)

Generate self-signed certificates for testing:

```bash
# Generate CA certificate
openssl req -x509 -newkey rsa:4096 -keyout certs/ca.key -out certs/ca.crt \
  -days 365 -nodes -subj "/CN=Caracal CA"

# Generate server certificate
openssl req -newkey rsa:4096 -keyout certs/server.key -out certs/server.csr \
  -nodes -subj "/CN=localhost"

openssl x509 -req -in certs/server.csr -CA certs/ca.crt -CAkey certs/ca.key \
  -CAcreateserial -out certs/server.crt -days 365

# Generate JWT key pair (for JWT authentication)
openssl genrsa -out certs/jwt_private.pem 4096
openssl rsa -in certs/jwt_private.pem -pubout -out certs/jwt_public.pem

# Clean up CSR
rm certs/server.csr
```

#### Option B: Production Certificates

Copy your production certificates to the `certs` directory:

```bash
cp /path/to/your/server.crt certs/
cp /path/to/your/server.key certs/
cp /path/to/your/ca.crt certs/
cp /path/to/your/jwt_public.pem certs/  # For JWT auth
```

### 4. Start Services

```bash
# Start all services in detached mode
docker-compose up -d

# View logs
docker-compose logs -f

# View logs for specific service
docker-compose logs -f gateway
docker-compose logs -f mcp-adapter
docker-compose logs -f postgres
```

### 5. Initialize Database

Wait for PostgreSQL to be ready, then run migrations:

```bash
# Check if database is ready
docker-compose exec postgres pg_isready -U caracal

# Run database migrations (if using Alembic)
docker-compose exec gateway caracal db migrate up

# Or initialize database schema
docker-compose exec gateway caracal db init
```

### 6. Verify Services

Check that all services are healthy:

```bash
# Check service status
docker-compose ps

# Test gateway health endpoint
curl -k https://localhost:8443/health

# Test MCP adapter health endpoint
curl http://localhost:8080/health

# View Prometheus metrics
curl http://localhost:9090/metrics
```

## Service Endpoints

### Gateway Proxy

- **HTTPS Gateway**: `https://localhost:8443`
- **Health Check**: `https://localhost:8443/health`
- **Statistics**: `https://localhost:8443/stats`
- **Prometheus Metrics**: `http://localhost:9090/metrics`

### MCP Adapter

- **HTTP API**: `http://localhost:8080`
- **Health Check**: `http://localhost:8080/health`
- **Statistics**: `http://localhost:8080/stats`
- **Tool Call**: `POST http://localhost:8080/mcp/tool/call`
- **Resource Read**: `POST http://localhost:8080/mcp/resource/read`

### PostgreSQL

- **Host**: `localhost`
- **Port**: `5432`
- **Database**: `caracal`
- **User**: `caracal`
- **Password**: (from `.env` file)

## Configuration

### Environment Variables

All configuration is done via environment variables in the `.env` file. See `.env.example` for all available options.

Key configuration sections:

- **Database**: Connection settings, pool size
- **Gateway**: Authentication mode, TLS settings, replay protection
- **Policy Cache**: Degraded mode settings
- **Provisional Charges**: Expiration and cleanup settings
- **MCP Adapter**: MCP server URLs, timeouts
- **Logging**: Log level and format

### Volume Mounts

The Docker Compose setup uses the following volume mounts:

```yaml
# TLS certificates (required)
./certs:/etc/caracal/tls:ro

# Optional: Custom configuration
./config:/etc/caracal/config:ro

# Optional: Persistent logs
./logs/gateway:/var/log/caracal
./logs/mcp-adapter:/var/log/caracal

# PostgreSQL data (managed by Docker)
postgres_data:/var/lib/postgresql/data
```

## Management Commands

### Start/Stop Services

```bash
# Start all services
docker-compose up -d

# Stop all services
docker-compose stop

# Stop and remove containers (keeps volumes)
docker-compose down

# Stop and remove containers and volumes (WARNING: deletes database!)
docker-compose down -v
```

### View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f gateway
docker-compose logs -f mcp-adapter
docker-compose logs -f postgres

# Last 100 lines
docker-compose logs --tail=100 gateway
```

### Execute Commands

```bash
# Execute Caracal CLI commands
docker-compose exec gateway caracal agent list
docker-compose exec gateway caracal policy list
docker-compose exec gateway caracal ledger summary

# Access PostgreSQL
docker-compose exec postgres psql -U caracal -d caracal

# Access container shell
docker-compose exec gateway /bin/bash
```

### Restart Services

```bash
# Restart all services
docker-compose restart

# Restart specific service
docker-compose restart gateway
docker-compose restart mcp-adapter
```

### Scale Services

```bash
# Scale gateway to 3 replicas (requires load balancer)
docker-compose up -d --scale gateway=3

# Scale MCP adapter to 2 replicas
docker-compose up -d --scale mcp-adapter=2
```

## Database Management

### Backup Database

```bash
# Create backup
docker-compose exec postgres pg_dump -U caracal caracal > backup.sql

# Or use caracal backup command
docker-compose exec gateway caracal db backup --output /tmp/backup.sql
```

### Restore Database

```bash
# Restore from backup
docker-compose exec -T postgres psql -U caracal caracal < backup.sql

# Or use caracal restore command
docker-compose exec gateway caracal db restore --input /tmp/backup.sql
```

### Access Database

```bash
# Interactive psql session
docker-compose exec postgres psql -U caracal -d caracal

# Run SQL query
docker-compose exec postgres psql -U caracal -d caracal -c "SELECT COUNT(*) FROM agent_identities;"
```

## Monitoring

### Prometheus Metrics

The gateway exposes Prometheus metrics on port 9090:

```bash
# View all metrics
curl http://localhost:9090/metrics

# Example metrics:
# - caracal_gateway_requests_total
# - caracal_gateway_request_duration_seconds
# - caracal_policy_evaluations_total
# - caracal_provisional_charges_active
# - caracal_database_queries_total
```

### Health Checks

```bash
# Gateway health
curl -k https://localhost:8443/health

# MCP adapter health
curl http://localhost:8080/health

# Database health
docker-compose exec postgres pg_isready -U caracal
```

### Service Statistics

```bash
# Gateway statistics
curl -k https://localhost:8443/stats

# MCP adapter statistics
curl http://localhost:8080/stats
```

## Troubleshooting

### Services Won't Start

1. Check Docker and Docker Compose versions:
   ```bash
   docker --version
   docker-compose --version
   ```

2. Check logs for errors:
   ```bash
   docker-compose logs
   ```

3. Verify environment variables:
   ```bash
   docker-compose config
   ```

### Database Connection Errors

1. Verify PostgreSQL is running:
   ```bash
   docker-compose ps postgres
   ```

2. Check database health:
   ```bash
   docker-compose exec postgres pg_isready -U caracal
   ```

3. Verify credentials in `.env` file

4. Check database logs:
   ```bash
   docker-compose logs postgres
   ```

### TLS Certificate Errors

1. Verify certificates exist:
   ```bash
   ls -la certs/
   ```

2. Check certificate validity:
   ```bash
   openssl x509 -in certs/server.crt -text -noout
   ```

3. Verify certificate permissions (should be readable)

### Gateway Not Responding

1. Check gateway logs:
   ```bash
   docker-compose logs gateway
   ```

2. Verify gateway is listening:
   ```bash
   docker-compose exec gateway netstat -tlnp | grep 8443
   ```

3. Test health endpoint:
   ```bash
   curl -k https://localhost:8443/health
   ```

### MCP Adapter Issues

1. Check MCP adapter logs:
   ```bash
   docker-compose logs mcp-adapter
   ```

2. Verify MCP servers are configured:
   ```bash
   echo $MCP_SERVERS
   ```

3. Test health endpoint:
   ```bash
   curl http://localhost:8080/health
   ```

## Production Deployment

### Security Checklist

- [ ] Change default database password in `.env`
- [ ] Use production TLS certificates (not self-signed)
- [ ] Configure firewall rules to restrict access
- [ ] Enable mTLS authentication for gateway
- [ ] Set up log aggregation and monitoring
- [ ] Configure backup strategy for PostgreSQL
- [ ] Review and adjust resource limits
- [ ] Enable HTTPS for MCP adapter if exposed externally
- [ ] Rotate JWT keys regularly
- [ ] Set up alerting for health check failures

### Resource Limits

Adjust resource limits in `docker-compose.yml` based on your workload:

```yaml
deploy:
  resources:
    limits:
      cpus: '2'
      memory: 2G
    reservations:
      cpus: '0.5'
      memory: 512M
```

### High Availability

For production high availability:

1. Use external PostgreSQL cluster (e.g., AWS RDS, Google Cloud SQL)
2. Deploy multiple gateway replicas behind a load balancer
3. Use external secrets management (e.g., HashiCorp Vault)
4. Set up monitoring and alerting (e.g., Prometheus + Grafana)
5. Configure automated backups and disaster recovery

## Next Steps

- Read the [Deployment Guide](docs/deployment-guide.md) for production setup
- Review [Configuration Options](config.v0.2.example.yaml) for advanced settings
- Set up [Monitoring and Alerting](docs/monitoring.md)
- Configure [Backup and Recovery](docs/backup-recovery.md)
- Integrate with your [CI/CD Pipeline](docs/cicd-integration.md)

## Support

For issues and questions:

- GitHub Issues: https://github.com/caracal/caracal-core/issues
- Documentation: https://docs.caracal.dev
- Community: https://community.caracal.dev
