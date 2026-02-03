# Caracal Core

**Economic control plane for AI agents.**

Caracal Core is a production-grade infrastructure layer that enforces budget policies, tracks resource usage, and manages agent identities at the network level. It acts as an economic firewall for agentic systems, ensuring autonomous agents operate within defined financial boundaries.

## Key Capabilities

*   **Network-Enforced Policies**: Gateway Proxy intercepts API calls to enforce budgets before execution.
*   **Hierarchical Delegation**: Support for parent-child agent structures with delegated spending limits.
*   **Production Storage**: PostgreSQL backend for scalable identity and ledger management.
*   **MCP Integration**: Native adapter for the Model Context Protocol (MCP).
*   **Economic Settlement**: Integrated with ASE v1.1.0 for cryptographic delegation and settlement.

## Quick Start

### Installation

```bash
uv pip install caracal-core
# or
pip install caracal-core
```

### Initialize System

Initialize the configuration and database schema:

```bash
caracal init
caracal db migrate up
```

### Start Gateway

Launch the policy enforcement gateway:

```bash
caracal gateway start
```

## Architecture

Caracal Core v0.3.0 follows a modular design:

*   **Gateway Proxy**: High-performance HTTP/gRPC reverse proxy for interception.
*   **Policy Engine**: Stateless decision engine for real-time budget enforcement.
*   **Agent Registry**: Identity management with PostgreSQL persistence.
*   **Ledger**: Immutable, append-only record of all economic events.
*   **MCP Adapter**: Bridge for connecting MCP-compliant tools and agents.

## Documentation

### Quick Start Guides
- [Docker Compose Quickstart](docs/DOCKER_COMPOSE_QUICKSTART.md) - Get started with Docker Compose
- [Docker Quickstart](docs/DOCKER_QUICKSTART.md) - Basic Docker setup
- [Docker MCP Quickstart](docs/DOCKER_MCP_QUICKSTART.md) - MCP integration with Docker
- [Kubernetes Quickstart](docs/KUBERNETES_QUICKSTART.md) - Deploy on Kubernetes

### Deployment & Operations
- [Deployment Guide](docs/DEPLOYMENT_GUIDE.md) - Complete deployment instructions
- [Production Guide](docs/PRODUCTION_GUIDE.md) - Production best practices
- [Operational Runbook](docs/OPERATIONAL_RUNBOOK.md) - Day-to-day operations

### Configuration
- [Configuration Example](config.example.yaml) - Complete configuration reference
- [Environment Variables](.env.example) - Environment variable reference

### Development & Release
- [Scripts Documentation](scripts/README.md) - Version management and release scripts
- [Release Notes](RELEASE_NOTES.md) - Latest release information

For full documentation, standard compliance details, and API reference, please visit our [official documentation](https://www.garudexlabs.com).

## Version Management

Caracal Core uses a single `VERSION` file as the source of truth for all version references. To update the version:

1. Edit the `VERSION` file with the new version number
2. Run `./scripts/update-version.sh` to update all references
3. Use `./scripts/release.sh` for automated release process

See [scripts/README.md](scripts/README.md) for detailed documentation.

## License

GNU Affero General Public License v3.0
