<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Installation

Caracal has two parts: a **server** you self-host and a **CLI** installed on each developer machine.

## Install the server

The server runs as a Docker Compose stack (API, web UI, PostgreSQL, ClickHouse, Redis, worker, load balancer). Prometheus and Grafana are optional deployment overlays.

> [!NOTE]
> Requires Docker Engine ≥ 24.0 with Compose v2 (`docker compose`, not `docker-compose`). Homebrew's Docker formula is outdated. Install [Docker Desktop](https://docs.docker.com/get-docker/) or use your distro's upstream packages. Verify with `docker version` and `docker compose version`.

**One-line install:**

```bash
curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install-server.sh | bash
```

This downloads a config package, runs guided setup (domain, secrets, ports), pulls container images from GHCR, and starts the full stack.

**From source** (for contributors):

```bash
git clone https://github.com/Garudex-Labs/caracal.git && cd caracal
cp .env.example .env
make up
```

For deployment options, see [Self-Hosting](../self-hosting/docker-compose.md) and [Production deployment](../self-hosting/production-deploy.md).

## Install the CLI

The CLI is what you use to log in, instrument harness configs, pull agents, and query traces.

## Install (standalone binary)

The standalone binary is the simplest way to install. No Python required.

```bash
curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install.sh | bash
```

This downloads the latest release binary for your platform and places it on your `PATH`.

This validates the Ed25519-signed key, installs the CLI, and writes the key to `~/.caracal/config.json`. If the key is invalid or expired, the installer exits with an error.

Verify it worked:

```bash
caracal --version
```

## Install from source (for contributors)

Requires Go 1.26 or newer.

```bash
git clone https://github.com/Garudex-Labs/caracal.git
cd caracal
go install ./cmd/caracal
```

## What gets installed

One binary lands on your `PATH`:

| Command                | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `caracal`             | The main CLI                                         |

## Upgrade

```bash
caracal self upgrade
```

## Uninstall

Standalone binary:

```bash
rm "$(which caracal)"
```

Uninstalling the CLI does **not** remove your config (`~/.caracal/`). Delete that folder if you want a clean slate:

```bash
rm -rf ~/.caracal
```

## Next

-> [Quickstart](quickstart.md)
