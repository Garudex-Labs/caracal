# packages/transport

## Scope
- Covers protocol transport packages under `packages/transport/`.

## Architecture Design
- `mcp/` owns Model Context Protocol authentication primitives.
- Framework adapters live under `packages/connectors/`, not here.

## Required
- Must keep protocol packages transport-focused and framework-neutral.
- Must keep each protocol implementation grouped by language.
- Must route token exchange, identity, and revocation through their owning packages.

## Forbidden
- Must not place Express, FastMCP, net/http middleware, Redis, or Postgres adapters here.
- Must not own runnable services or application code.

## Validation
- Validate through the touched protocol child package.

