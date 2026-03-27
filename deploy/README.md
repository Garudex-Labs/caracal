# Deploy Artifacts

This directory contains the supported open-source deployment assets for Caracal.

## Layout

- `deploy/docker-compose.yml`: broker-mode local stack for PostgreSQL, Redis, and the MCP adapter
- `deploy/docker/`: Dockerfiles for `caracal`, `caracal-flow`, and the MCP adapter
- `deploy/config/config.example.yaml`: minimal OSS runtime configuration

## Usage

Start infrastructure and the MCP adapter:

```bash
docker compose -f deploy/docker-compose.yml up -d postgres redis mcp
```

Run CLI commands in a container:

```bash
docker compose -f deploy/docker-compose.yml run --rm cli --help
```

Run the TUI in a container:

```bash
docker compose -f deploy/docker-compose.yml run --rm --service-ports flow
```

The deploy assets intentionally exclude gateway services and gateway-specific configuration.
