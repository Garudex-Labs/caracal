<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Docker Compose setup

Step-by-step bring-up of the Caracal stack. End state: the core services are healthy, API responding at `http://localhost/health`, web UI at `http://localhost`. Prometheus and Grafana are optional.

## 1. Clone and configure

```bash
git clone https://github.com/Garudex-Labs/caracal.git
cd caracal
cp .env.example .env
```

The `.env.example` ships with working direct-value defaults for local source development. You do not need to edit it for local development. Production server-package installs use generated files under `secrets/` instead; see [Configuration](configuration.md#secret-files).

> [!NOTE]
> You need Docker Engine ≥ 24.0 with Compose v2 (`docker compose`, not `docker-compose`). Homebrew's Docker formula is outdated. Install [Docker Desktop](https://docs.docker.com/get-docker/) or use your distro's upstream packages. Verify with `docker version` and `docker compose version`.

## 2. Start the stack

Core stack only:

```bash
docker compose -f infra/docker/docker-compose.yml up --build -d
```

With Prometheus only:

```bash
docker compose -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.observability.yml up --build -d
```

With Prometheus and Grafana:

```bash
COMPOSE_PROFILES=grafana docker compose -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.observability.yml up --build -d
```

First build takes a few minutes (pulls images, builds `caracal-api` and `caracal-web`). Subsequent starts are fast.

## 3. Verify health

```bash
docker compose -f infra/docker/docker-compose.yml ps
```

Every service should show `healthy` or `running`. The API waits for Postgres, ClickHouse, and Redis to pass health checks before starting. Expect 15–30 seconds on first boot.

Hit the health endpoint:

```bash
curl http://localhost/health
# {"status":"ok"}
```

## 4. Configure TLS (production only)

For local dev, `http://localhost` is fine. For production, put a TLS-terminating reverse proxy in front of the nginx LB. See [Requirements → TLS / HTTPS](requirements.md#tls--https).

## 5. Bootstrap the first user

A fresh stack has no accounts. Run:

```bash
curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install.sh | bash   # if you haven't already
caracal auth login
# Server URL: http://localhost
# No users detected - bootstrapping operator account.
# Email: richard@your-company.com
# Password: **************
```

The CLI detects that no users exist and interactively creates the first deployment operator. The `/api/v1/auth/bootstrap` endpoint is restricted to localhost access for security.

For local development only, the web login page can additionally offer a **Development login** button. It is double-gated server-side and can never be enabled in production - see [Configuration → Development-only login](configuration.md#development-only-login).

## 6. Verify with the CLI

```bash
caracal auth whoami
caracal auth status

caracal registry mcp list         # empty list - you haven't added anything yet
```

## 7. Stop, restart, rebuild

```bash
# Stop core and any optional monitoring containers
make down

# Stop and delete all data, including optional monitoring volumes
docker compose -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.observability.yml --profile grafana down -v

# Restart one service
docker compose -f infra/docker/docker-compose.yml restart caracal-api

# Rebuild after code changes
docker compose -f infra/docker/docker-compose.yml up --build -d caracal-api
```

Makefile shortcuts from the repo root:

```bash
make logs                  # tail service logs (S="caracal-server" filters)
make rebuild               # rebuild and restart core services
make up OBS=prometheus     # start core services with Prometheus
make up OBS=grafana        # start core services with Prometheus and Grafana
make rebuild OBS=grafana   # rebuild core services with Prometheus and Grafana
make reset                 # delete all data and rebuild (asks for confirmation)
```

## 8. Logs

```bash
docker compose -f infra/docker/docker-compose.yml logs -f                # all
docker compose -f infra/docker/docker-compose.yml logs -f caracal-api   # one service
```

## 9. Port conflicts

If `docker compose up` fails with `port is already allocated`, remap host ports via env vars:

```bash
POSTGRES_HOST_PORT=5433 REDIS_HOST_PORT=6380 \
  docker compose -f infra/docker/docker-compose.yml up --build -d
```

Every host port is configurable. See [Ports and volumes](ports-and-volumes.md) for the full list.

## Next

→ [Configuration](configuration.md): which env vars to change for production.
