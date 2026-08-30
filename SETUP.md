<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Setup Guide

Everything you need to get Caracal running locally for development or self-hosted production.

> **Full documentation** lives in [`/docs`](docs/) - a Mintlify site (`docs/docs.json`); preview locally with `mint dev`. This file covers the fastest path from zero to a working stack.
>
> The steps below use the source Compose stack for development. The one-line server-package installer instead generates restricted files under `secrets/`, stores only `NAME_FILE` paths in `.env`, and binds published ports to loopback. The same install command runs guided setup with a terminal or safe defaults without one, so CI and coding agents need no special flag. See [Configuration](docs/self-hosting/configuration.md#secret-files) for the packaged layout and rotation rules.

---

## Prerequisites

| Requirement       | Minimum               | Notes                                                                                                                                                                                                                                    |
| ----------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Docker Engine** | 24.0+ with Compose v2 | Use `docker compose` (not `docker-compose`). Homebrew Docker is often outdated - use [Docker Desktop](https://docs.docker.com/get-docker/) or your distro's upstream packages. Check with `docker version` and `docker compose version`. |
| **Go**            | 1.25+                 | Only needed to build the CLI from source.                                                                                                                                                                                                |
| **Python**        | 3.11+                 | Only needed to run the repo-level contract tests.                                                                                                                                                                                        |
| **RAM**           | 4 GB+                 | ClickHouse is the memory consumer. 6 GB recommended for comfortable use.                                                                                                                                                                 |
| **Disk**          | 5 GB+                 | For Docker images and data volumes.                                                                                                                                                                                                      |

---

## 1. Clone and configure

```bash
git clone https://github.com/Garudex-Labs/caracal.git
cd caracal
cp .env.example .env
```

`.env.example` ships with working defaults; you don't need to edit anything for local development. A fresh server has no accounts - the first `caracal auth login` bootstraps the administrator.

> **Before a real deployment from source:** change `SECRET_KEY`, `POSTGRES_PASSWORD`, and `CLICKHOUSE_PASSWORD`, and never enable `AUTH_DEV_LOGIN`. Server-package installs generate these credentials as files automatically. See the [Self-hosting overview](docs/self-hosting/README.md), [Configuration](docs/self-hosting/configuration.md), [Databases](docs/self-hosting/databases.md), and [Upgrades](docs/self-hosting/upgrades.md).

---

## 2. Start the stack

```bash
make up
```

`make up` builds the local images from this checkout, starts the stack, and waits for both the API and web frontend health checks. After `make purge`, use `make up` to rebuild from source instead of pulling a stale published web image.

Or without Make:

```bash
docker compose -f infra/docker/docker-compose.yml up --build -d
```

First build pulls images and compiles the Vite frontend. Expect 3 to 5 minutes. Subsequent starts are under 30 seconds.

**What comes up (8 services):**

| Service               | URL                     | Purpose                                  |
| --------------------- | ----------------------- | ---------------------------------------- |
| `caracal-lb` (nginx) | `http://localhost`      | Reverse proxy (API + Web)                |
| `caracal-web`        | `http://localhost:8000` | Web UI (Vite static app, direct access)  |
| `caracal-server`     | internal                | Go API server (background jobs run here) |
| `caracal-auth`       | internal                | Identity service                         |
| `caracal-init`       | internal                | Runs DB migrations on startup then exits |
| `caracal-db`         | `localhost:5432`        | PostgreSQL (registry data)               |
| `caracal-clickhouse` | `localhost:8123`        | ClickHouse (session and audit events)    |
| `caracal-redis`      | `localhost:6379`        | Pub/sub, cache, token revocation         |

`make up OBS=grafana` adds `caracal-prometheus` (`http://localhost:9090`) and `caracal-grafana` (`http://localhost:8002`); `make up OBS=prometheus` adds Prometheus only.

---

## 3. Verify health

```bash
docker compose -f infra/docker/docker-compose.yml ps
```

All services except `caracal-init` (which exits after migrations) should show `healthy` or `running`. The API waits for Postgres, ClickHouse, and Redis before starting. Allow 15–30 seconds on first boot.

Confirm the API is up:

```bash
curl http://localhost/health
# {"status":"ok","postgres":"ok","initialized":true,"clickhouse":"ok","redis":"ok"}
```

Open the web UI at **http://localhost**.

---

## 4. Install the CLI

**Development build from source** (picks up local changes):

```bash
go build -ldflags "-X main.cliVersion=$(grep -m1 '^version' .release.toml | sed 's/.*\"\(.*\)\"/\1/')" -o ~/.local/bin/caracal ./cmd/caracal
```

**Via the installer** (prebuilt binaries):

```bash
curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install.sh | bash
```

**Via Homebrew** (macOS Apple Silicon, Linux x64/arm64):

```bash
brew install garudex-labs/caracal/caracal-cli
```

Verify: `caracal --version`

---

## 5. Log in

```bash
caracal auth login
```

On a fresh server this prompts:

1. **Server URL** → press Enter for `http://localhost`
2. **No users detected** → the CLI bootstraps the administrator account with the email, name, and password you choose

Check it worked:

```bash
caracal auth whoami
# you@your-company.com (super_admin)

caracal auth status
# Server:  http://localhost - OK
# Auth:    you@your-company.com (super_admin)
# Buffer:  0 pending events
```

---

## 6. Run the tests

```bash
make test           # full suite: Go (incl. contract tests in tests/) + web
make test SUITE=go  # Go tests only (go test -race ./...)
make test SUITE=web # web unit tests only
```

All tests mock external services. No Docker or live databases needed to run tests.

---

## 7. Instrument your harnesses

Already have Claude Code, Kiro, Cursor, or another harness configured? Install session telemetry hooks without changing MCP commands:

```bash
caracal scan                              # read-only: see what's installed
caracal doctor patch --all-harnesses      # install session telemetry hooks
caracal doctor                            # verify everything wired correctly
```

`scan` never modifies files. `doctor patch` only manages session telemetry hooks.

---

## 8. Common operations

```bash
make down       # stop all services
make rebuild    # rebuild images and restart
make logs       # tail all service logs (S="caracal-server" to filter)
make lint       # gofmt + go vet
make format     # gofmt -w
make check      # pre-commit on all files
make setup      # install pre-commit hooks
```

Restart a single service:

```bash
docker compose -f infra/docker/docker-compose.yml restart caracal-server
```

Wipe all data (destructive):

```bash
docker compose -f infra/docker/docker-compose.yml down -v
```

---

## 9. Port conflicts

Every host port is overridable via env var:

| Variable               | Default | Service        |
| ---------------------- | ------- | -------------- |
| `API_HOST_PORT`        | `8080`  | nginx LB → API |
| `WEB_HOST_PORT`        | `3000`  | Web UI         |
| `POSTGRES_HOST_PORT`   | `5432`  | PostgreSQL     |
| `CLICKHOUSE_HOST_PORT` | `8123`  | ClickHouse     |
| `REDIS_HOST_PORT`      | `6379`  | Redis          |
| `PROMETHEUS_HOST_PORT` | `9090`  | Prometheus     |
| `GRAFANA_HOST_PORT`    | `8002`  | Grafana        |

Example:

```bash
API_HOST_PORT=8081 WEB_HOST_PORT=8005 \
  docker compose -f infra/docker/docker-compose.yml up --build -d
```

---

## Further reading

Deployment and operations:

| Topic | Link |
| ----- | ---- |
| Self-hosting overview | [Self-Hosting](docs/self-hosting/README.md) |
| Single-node deployment | [Single-node deployment](docs/self-hosting/single-node.mdx) |
| Docker Compose deployment | [Docker Compose setup](docs/self-hosting/docker-compose.md) |
| Production hardening | [Configuration](docs/self-hosting/configuration.md) |
| Databases and migrations | [Databases](docs/self-hosting/databases.md) |
| Ports and volumes | [Ports and volumes](docs/self-hosting/ports-and-volumes.md) |
| Upgrade safely | [Upgrades](docs/self-hosting/upgrades.md) |
| Backup and restore | [Backup and restore](docs/self-hosting/backup-and-restore.md) |
| Troubleshooting | [Troubleshooting](docs/self-hosting/troubleshooting.md) |

Product setup:

| Topic | Link |
| ----- | ---- |
| 5-minute first trace | [Quickstart](docs/getting-started/quickstart.md) |
| All environment variables | [Environment variables](docs/reference/environment-variables.md) |
| Configure SSO / OIDC | [Authentication and SSO](docs/self-hosting/authentication.md) |
