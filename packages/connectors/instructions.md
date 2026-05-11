# packages/connectors

## Scope
- Covers framework and infrastructure adapters that wire a host runtime into Caracal.

## Required
- Each child must depend only on `packages/core`, `packages/identity`, `packages/sdk`, `packages/transport`, and the framework it adapts.
- Each child must verify every inbound bearer through STS or the embedded SDK before invoking the host application.
- Each child must surface a runbook entry covering how requests bypass Caracal when the host is reached directly (without the connector).

## Forbidden
- Must not provide a public path that forwards an unverified request to the host application.
- Must not stub out token verification with environment toggles in production builds.
- Must not depend on another `packages/connectors/*` sibling; share through the approved core/identity/sdk layers only.

## Direct-API bypass posture
- A connector enforces Caracal only on traffic that reaches it. Any host port left open outside the connector (private LAN, sidecar bypass, raw provider key) is outside Caracal's trust boundary.
- Production deployments must front the host with the connector or the gateway, and must firewall every other path.
- The CLI `caracal init` scaffold prints this warning on every fresh project; do not remove it.
