# Deploy Artifacts

This directory contains the supported open-source deployment assets for Caracal.

The runtime model is container-first:

- Host `caracal` orchestrates Docker Compose runtime services.
- CLI and Flow execution happen inside the runtime container.
- Runtime state lives in `CARACAL_HOME` (default `/home/caracal/.caracal`) inside the runtime container.
- Workspace import/export files use host-local storage mounted at `/caracal-host-io` (`CARACAL_HOST_IO_DIR` on host).
- Open-source broker runtime is standalone; enterprise integration is remote via URL only.

## Layout

- `deploy/docker-compose.yml`: runtime stack for PostgreSQL, Redis, runtime API (`mcp`), CLI, and Flow
- `deploy/docker-compose.image.yml`: image-only runtime stack (no local build context required)
- `deploy/docker/`: container runtime assets
- `deploy/config/config.example.yaml`: minimal OSS runtime configuration

## Usage

Start the runtime stack (broker mode):

```bash
docker compose -f deploy/docker-compose.yml up -d mcp

# Or pull-and-run mode (no local build)
docker compose -f deploy/docker-compose.image.yml pull
docker compose -f deploy/docker-compose.image.yml up -d mcp
```

Run CLI commands in a container:

```bash
docker compose -f deploy/docker-compose.yml exec mcp /bin/bash
# then inside the container shell:
caracal --help
```

Run the TUI in a container:

```bash
docker compose -f deploy/docker-compose.yml exec mcp caracal flow
```

Use enterprise integration mode by setting `CARACAL_ENTERPRISE_URL` to a reachable hosted endpoint before starting `mcp`.

```bash
export CARACAL_ENTERPRISE_URL=https://enterprise.example.com
export CARACAL_GATEWAY_ENABLED=true
docker compose -f deploy/docker-compose.yml up -d mcp
```

### Runtime Modes

Set `CARACAL_ENV_MODE` to `dev`, `staging`, or `prod`.

- `dev`: human-readable logs by default, DEBUG allowed only when `CARACAL_DEBUG_LOGS=true`
- `staging`: JSON logs, sensitive fields redacted, DEBUG disabled
- `prod`: JSON logs, sensitive fields redacted, DEBUG disabled

`CARACAL_JSON_LOGS=true` forces JSON logging in `dev` mode.

### Default Host UX

When installed from source, host commands launch the same containers by default:

```bash
caracal --help
caracal cli
caracal flow
```
