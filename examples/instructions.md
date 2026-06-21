# examples

## Scope
- Covers runnable example applications under `examples/`.

## Architecture Design
- Each example is self-contained and demonstrates Caracal through public SDKs and connectors only.
- Example-specific mocks, fixtures, configuration, and tests stay inside the example directory.

## Required
- Must keep each example independently installable from its own manifest.
- Must use only published/public Caracal package surfaces.
- Must keep external systems mocked or deterministic.
- Must place example tests inside the example directory.

## Forbidden
- Must not import directly from repository internals under `apps/`, `services/`, or unpublished package source.
- Must not call live third-party services from example tests.
- Must not commit secrets, real API keys, or production endpoints.
- Must not mint Control API keys: setting the `control:invoke` or `control:scope:` application traits is a Console-only, TTY-gated operation. Examples consume a scoped Control key (`CONTROL_CLIENT_ID` / `CONTROL_CLIENT_SECRET`) created by a human in the Console (Control menu).
- Must not read Caracal's internal managed admin secret (`caracalAdminToken`). Use an operator-supplied `CARACAL_ADMIN_TOKEN` env for ordinary admin-API demos, never the on-disk master secret.

## Validation
- Validate each touched example from its own directory using its declared test command.

