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

Caracal Core v0.2.0 follows a modular design:

*   **Gateway Proxy**: High-performance HTTP/gRPC reverse proxy for interception.
*   **Policy Engine**: Stateless decision engine for real-time budget enforcement.
*   **Agent Registry**: Identity management with PostgreSQL persistence.
*   **Ledger**: Immutable, append-only record of all economic events.
*   **MCP Adapter**: Bridge for connecting MCP-compliant tools and agents.

## Documentation

For full documentation, standard compliance details, and API reference, please visit our [official documentation](https://www.garudexlabs.com).

## License

GNU Affero General Public License v3.0
