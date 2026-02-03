# Docker Quick Start Guide - MCP Adapter

This guide provides quick instructions for building and running the Caracal MCP Adapter using Docker.

## Prerequisites

- Docker 20.10+ installed
- PostgreSQL database accessible (can be local or remote)
- MCP servers to connect to (optional for testing)

## Building the Image

Build the MCP Adapter Docker image:

```bash
docker build -f Dockerfile.mcp -t caracal-mcp-adapter:latest .
```

For a specific version:

```bash
docker build -f Dockerfile.mcp -t caracal-mcp-adapter:0.3.0 .
```

## Running the Container

### Basic Run (Standalone)

```bash
docker run -p 8080:8080 \
  -e DB_HOST=host.docker.internal \
  -e DB_PORT=5432 \
  -e DB_NAME=caracal \
  -e DB_USER=caracal \
  -e DB_PASSWORD=your_password \
  caracal-mcp-adapter:latest
```

### Run with MCP Servers

Configure MCP servers using the `MCP_SERVERS` environment variable:

```bash
docker run -p 8080:8080 \
  -e DB_HOST=host.docker.internal \
  -e DB_PORT=5432 \
  -e DB_NAME=caracal \
  -e DB_USER=caracal \
  -e DB_PASSWORD=your_password \
  -e MCP_SERVERS="openai:http://mcp-openai:8000,anthropic:http://mcp-anthropic:8000" \
  caracal-mcp-adapter:latest
```

### Run with Custom Configuration

```bash
docker run -p 8080:8080 \
  -e DB_HOST=postgres \
  -e DB_PORT=5432 \
  -e DB_NAME=caracal \
  -e DB_USER=caracal \
  -e DB_PASSWORD=your_password \
  -e LOG_LEVEL=DEBUG \
  -e REQUEST_TIMEOUT=60 \
  -e MAX_REQUEST_SIZE_MB=20 \
  -e MCP_SERVER_TIMEOUT=45 \
  -e MCP_SERVERS="server1:http://mcp1:8000,server2:http://mcp2:8000" \
  caracal-mcp-adapter:latest
```

## Environment Variables

### Required

- `DB_HOST`: PostgreSQL host (default: `localhost`)
- `DB_PORT`: PostgreSQL port (default: `5432`)
- `DB_NAME`: Database name (default: `caracal`)
- `DB_USER`: Database user (default: `caracal`)
- `DB_PASSWORD`: Database password (required)

### Optional

- `LOG_LEVEL`: Logging level - DEBUG, INFO, WARNING, ERROR (default: `INFO`)
- `LISTEN_ADDRESS`: Address to bind the server (default: `0.0.0.0:8080`)
- `REQUEST_TIMEOUT`: Request timeout in seconds (default: `30`)
- `MAX_REQUEST_SIZE_MB`: Maximum request body size in MB (default: `10`)
- `MCP_SERVER_TIMEOUT`: Timeout for MCP server requests in seconds (default: `30`)
- `MCP_SERVERS`: Comma-separated list of MCP servers in format `name:url` (default: empty)
- `DB_POOL_SIZE`: Database connection pool size (default: `10`)
- `DB_MAX_OVERFLOW`: Maximum overflow connections (default: `5`)
- `DB_POOL_TIMEOUT`: Connection pool timeout in seconds (default: `30`)
- `PROVISIONAL_CHARGE_EXPIRATION`: Provisional charge expiration in seconds (default: `300`)
- `PROVISIONAL_CHARGE_MAX_TIMEOUT`: Maximum provisional charge timeout in minutes (default: `60`)
- `PROVISIONAL_CHARGE_CLEANUP_INTERVAL`: Cleanup interval in seconds (default: `60`)
- `PROVISIONAL_CHARGE_CLEANUP_BATCH_SIZE`: Cleanup batch size (default: `1000`)

## Exposed Ports

- **8080**: HTTP API for MCP request proxying

## Health Check

The container includes a health check that runs every 30 seconds:

```bash
# Check health status
docker inspect --format='{{.State.Health.Status}}' <container_id>

# View health check logs
docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' <container_id>
```

Or test manually:

```bash
curl http://localhost:8080/health
```

Expected response when healthy:

```json
{
  "status": "healthy",
  "service": "caracal-mcp-adapter",
  "version": "0.3.0",
  "mcp_servers": {
    "server1": "healthy",
    "server2": "healthy",
    "database": "healthy"
  }
}
```

## API Endpoints

### Health Check

```bash
curl http://localhost:8080/health
```

### Service Statistics

```bash
curl http://localhost:8080/stats
```

### Intercept MCP Tool Call

```bash
curl -X POST http://localhost:8080/mcp/tool/call \
  -H "Content-Type: application/json" \
  -d '{
    "tool_name": "search",
    "tool_args": {"query": "AI agents", "max_results": 10},
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "metadata": {}
  }'
```

### Intercept MCP Resource Read

```bash
curl -X POST http://localhost:8080/mcp/resource/read \
  -H "Content-Type: application/json" \
  -d '{
    "resource_uri": "file:///data/document.txt",
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "metadata": {}
  }'
```

## Docker Compose Example

Create a `docker-compose.mcp.yml` file:

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:14
    environment:
      POSTGRES_DB: caracal
      POSTGRES_USER: caracal
      POSTGRES_PASSWORD: caracal_password
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U caracal"]
      interval: 10s
      timeout: 5s
      retries: 5

  mcp-adapter:
    image: caracal-mcp-adapter:latest
    ports:
      - "8080:8080"
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: caracal
      DB_USER: caracal
      DB_PASSWORD: caracal_password
      LOG_LEVEL: INFO
      MCP_SERVERS: "openai:http://mcp-openai:8000,anthropic:http://mcp-anthropic:8000"
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8080/health').read()"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

volumes:
  postgres_data:
```

Run with Docker Compose:

```bash
docker-compose -f docker-compose.mcp.yml up -d
```

## Troubleshooting

### Container won't start

Check logs:

```bash
docker logs <container_id>
```

Common issues:
- Database connection failed: Verify `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`
- Port already in use: Change the host port mapping (e.g., `-p 8081:8080`)

### Health check failing

Check health status:

```bash
docker inspect --format='{{json .State.Health}}' <container_id> | jq
```

Common causes:
- Database unreachable
- MCP servers unreachable
- Service startup taking longer than expected (increase `start_period` in health check)

### High memory usage

Adjust database connection pool:

```bash
docker run ... \
  -e DB_POOL_SIZE=5 \
  -e DB_MAX_OVERFLOW=2 \
  ...
```

### Debugging

Run with debug logging:

```bash
docker run ... \
  -e LOG_LEVEL=DEBUG \
  ...
```

Access container shell:

```bash
docker exec -it <container_id> /bin/bash
```

## Production Deployment

For production deployments:

1. Use specific version tags instead of `latest`
2. Set appropriate resource limits:
   ```bash
   docker run --memory=512m --cpus=1 ...
   ```
3. Use secrets management for `DB_PASSWORD`
4. Configure log aggregation
5. Set up monitoring and alerting
6. Use orchestration (Kubernetes, Docker Swarm)

## Next Steps

- See `DOCKER_IMPLEMENTATION_SUMMARY.md` for architecture details
- See Kubernetes manifests in task 17.4 for production deployment
- Configure MCP servers according to your needs
- Set up monitoring with Prometheus metrics

## Requirements

This implementation satisfies:
- **Requirement 18.1**: MCP Adapter deployable as standalone service via Docker
- Multi-stage build for minimal image size
- Exposes port 8080 for HTTP API
- Health check endpoints for monitoring
- Configuration via environment variables
