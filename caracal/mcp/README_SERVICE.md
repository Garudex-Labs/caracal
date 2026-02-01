# MCP Adapter Standalone Service

The MCP Adapter Standalone Service provides an HTTP API for intercepting MCP (Model Context Protocol) tool calls and resource reads with budget enforcement.

## Features

- **HTTP API**: RESTful API for MCP request proxying
- **Budget Enforcement**: Automatic budget checks before forwarding requests
- **Metering**: Automatic cost tracking and ledger events
- **Health Checks**: Built-in health check endpoints for monitoring
- **Configuration**: Flexible configuration via YAML files or environment variables

## Requirements

- Python 3.10+
- PostgreSQL 14+ (for Caracal Core backend)
- FastAPI and dependencies (installed with Caracal)

## Installation

The MCP Adapter Service is included with Caracal Core:

```bash
pip install caracal-core
```

## Configuration

### Option 1: YAML Configuration File

Create a configuration file (e.g., `/etc/caracal/config.yaml`):

```yaml
mcp_adapter:
  enabled: true
  mode: "service"
  listen_address: "0.0.0.0:8080"
  request_timeout_seconds: 30
  max_request_size_mb: 10
  enable_health_check: true
  health_check_path: "/health"
  
  mcp_servers:
    - name: "filesystem"
      url: "http://mcp-filesystem:9000"
      timeout_seconds: 30
    - name: "database"
      url: "http://mcp-database:9001"
      timeout_seconds: 30

database:
  host: localhost
  port: 5432
  database: caracal
  user: caracal_user
  password: ${CARACAL_DB_PASSWORD}
```

### Option 2: Environment Variables

```bash
export CARACAL_MCP_LISTEN_ADDRESS="0.0.0.0:8080"
export CARACAL_MCP_SERVERS='[{"name":"filesystem","url":"http://localhost:9000"},{"name":"database","url":"http://localhost:9001"}]'
export CARACAL_MCP_REQUEST_TIMEOUT=30
export CARACAL_MCP_MAX_REQUEST_SIZE_MB=10

# Database configuration
export CARACAL_DB_HOST=localhost
export CARACAL_DB_PORT=5432
export CARACAL_DB_NAME=caracal
export CARACAL_DB_USER=caracal_user
export CARACAL_DB_PASSWORD=your_password
```

## Usage

### Starting the Service

#### With Configuration File

```bash
caracal mcp-service start --config /etc/caracal/config.yaml
```

#### With Environment Variables

```bash
export CARACAL_CONFIG_PATH=/etc/caracal/config.yaml
caracal mcp-service start
```

#### Direct Python Execution

```bash
python -m caracal.mcp.service
```

### Health Check

Check if the service is running:

```bash
caracal mcp-service health
```

Or use curl:

```bash
curl http://localhost:8080/health
```

Response:

```json
{
  "status": "healthy",
  "service": "caracal-mcp-adapter",
  "version": "0.2.0",
  "mcp_servers": {
    "filesystem": "healthy",
    "database": "healthy"
  }
}
```

### Service Statistics

Get service statistics:

```bash
caracal mcp-service stats
```

Or use curl:

```bash
curl http://localhost:8080/stats
```

Response:

```json
{
  "requests_total": 1234,
  "tool_calls_total": 890,
  "resource_reads_total": 344,
  "requests_allowed": 1200,
  "requests_denied": 34,
  "errors_total": 0,
  "mcp_servers": [
    {"name": "filesystem", "url": "http://mcp-filesystem:9000"},
    {"name": "database", "url": "http://mcp-database:9001"}
  ]
}
```

## API Endpoints

### POST /mcp/tool/call

Intercept and forward an MCP tool call.

**Request:**

```json
{
  "tool_name": "read_file",
  "tool_args": {
    "path": "/data/document.txt"
  },
  "agent_id": "550e8400-e29b-41d4-a716-446655440000",
  "metadata": {
    "request_id": "req-123"
  }
}
```

**Response (Success):**

```json
{
  "success": true,
  "result": {
    "content": "File contents...",
    "size": 1024
  },
  "error": null,
  "metadata": {
    "estimated_cost": "0.001",
    "actual_cost": "0.001",
    "provisional_charge_id": "charge-uuid",
    "remaining_budget": "99.50"
  }
}
```

**Response (Budget Exceeded):**

```json
{
  "success": false,
  "result": null,
  "error": "Budget exceeded: Insufficient budget",
  "metadata": {
    "error_type": "budget_exceeded"
  }
}
```

### POST /mcp/resource/read

Intercept and forward an MCP resource read.

**Request:**

```json
{
  "resource_uri": "file:///data/document.txt",
  "agent_id": "550e8400-e29b-41d4-a716-446655440000",
  "metadata": {
    "request_id": "req-124"
  }
}
```

**Response:**

```json
{
  "success": true,
  "result": {
    "uri": "file:///data/document.txt",
    "content": "Resource content...",
    "mime_type": "text/plain",
    "size": 2048
  },
  "error": null,
  "metadata": {
    "estimated_cost": "0.002",
    "actual_cost": "0.002",
    "provisional_charge_id": "charge-uuid",
    "remaining_budget": "99.48",
    "resource_size": 2048
  }
}
```

### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "healthy",
  "service": "caracal-mcp-adapter",
  "version": "0.2.0",
  "mcp_servers": {
    "filesystem": "healthy",
    "database": "healthy"
  }
}
```

### GET /stats

Service statistics endpoint.

**Response:**

```json
{
  "requests_total": 1234,
  "tool_calls_total": 890,
  "resource_reads_total": 344,
  "requests_allowed": 1200,
  "requests_denied": 34,
  "errors_total": 0,
  "mcp_servers": [
    {"name": "filesystem", "url": "http://mcp-filesystem:9000"},
    {"name": "database", "url": "http://mcp-database:9001"}
  ]
}
```

## Docker Deployment

### Dockerfile

```dockerfile
FROM python:3.10-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY caracal/ ./caracal/

# Expose port
EXPOSE 8080

# Run service
CMD ["python", "-m", "caracal.mcp.service"]
```

### Docker Compose

```yaml
version: '3.8'

services:
  mcp-adapter:
    build: .
    ports:
      - "8080:8080"
    environment:
      - CARACAL_MCP_LISTEN_ADDRESS=0.0.0.0:8080
      - CARACAL_MCP_SERVERS=[{"name":"filesystem","url":"http://mcp-filesystem:9000"}]
      - CARACAL_DB_HOST=postgres
      - CARACAL_DB_PORT=5432
      - CARACAL_DB_NAME=caracal
      - CARACAL_DB_USER=caracal_user
      - CARACAL_DB_PASSWORD=password
    depends_on:
      - postgres
      - mcp-filesystem
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
  
  postgres:
    image: postgres:14
    environment:
      - POSTGRES_DB=caracal
      - POSTGRES_USER=caracal_user
      - POSTGRES_PASSWORD=password
    volumes:
      - postgres_data:/var/lib/postgresql/data
  
  mcp-filesystem:
    image: mcp-filesystem:latest
    ports:
      - "9000:9000"

volumes:
  postgres_data:
```

## Kubernetes Deployment

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-adapter
  labels:
    app: mcp-adapter
spec:
  replicas: 3
  selector:
    matchLabels:
      app: mcp-adapter
  template:
    metadata:
      labels:
        app: mcp-adapter
    spec:
      containers:
      - name: mcp-adapter
        image: caracal/mcp-adapter:0.2.0
        ports:
        - containerPort: 8080
          name: http
        env:
        - name: CARACAL_MCP_LISTEN_ADDRESS
          value: "0.0.0.0:8080"
        - name: CARACAL_DB_HOST
          value: "postgres"
        - name: CARACAL_DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: caracal-secrets
              key: db-password
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
```

### Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: mcp-adapter
spec:
  selector:
    app: mcp-adapter
  ports:
  - protocol: TCP
    port: 8080
    targetPort: 8080
  type: LoadBalancer
```

## Monitoring

The service exposes metrics and logs for monitoring:

### Logs

Structured JSON logs are written to stdout:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "INFO",
  "message": "Tool call completed",
  "tool": "read_file",
  "agent": "550e8400-e29b-41d4-a716-446655440000",
  "success": true,
  "duration_ms": 45.2
}
```

### Health Checks

Use the `/health` endpoint for liveness and readiness probes.

### Statistics

Use the `/stats` endpoint to monitor request counts and performance.

## Troubleshooting

### Service Won't Start

1. Check database connectivity:
   ```bash
   psql -h localhost -U caracal_user -d caracal
   ```

2. Verify configuration:
   ```bash
   cat /etc/caracal/config.yaml
   ```

3. Check logs:
   ```bash
   tail -f /var/log/caracal/caracal.log
   ```

### Budget Checks Failing

1. Verify agent exists:
   ```bash
   caracal agent get --agent-id <uuid>
   ```

2. Check policy:
   ```bash
   caracal policy list --agent-id <uuid>
   ```

3. Check spending:
   ```bash
   caracal ledger summary --agent-id <uuid>
   ```

### MCP Server Connectivity Issues

1. Check MCP server health:
   ```bash
   curl http://mcp-filesystem:9000/health
   ```

2. Verify network connectivity:
   ```bash
   ping mcp-filesystem
   ```

3. Check service logs for connection errors

## See Also

- [MCP Adapter README](README.md) - Overview of MCP adapter
- [MCP Decorator README](README_DECORATOR.md) - SDK plugin mode
- [Caracal Core Documentation](../../README.md) - Main documentation
