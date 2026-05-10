---
title: Services
description: STS, gateway, audit, and broker components in detail.
---

This page lists each Caracal service, what it owns, and which contracts it
exposes. See [System Overview](/architecture/system) for how they compose, and
[Threat Model](/security/threat-model) for the security guarantees each
service contributes.

## STS — `services/sts`

The token issuer and authority root.

- **Endpoints:** `POST /oauth/2/token` (RFC 8693 exchange),
  `GET /.well-known/jwks.json?zone_id=<zone>`, `GET /healthz`.
- **Owns:** application authentication, OPA policy evaluation, ES256 signing
  keys, provider-credential vault (zone-scoped ZEK), step-up challenges, JTI
  issuance ledger.
- **Database:** authoritative for zones, applications, resources,
  delegations, signing keys.
- **Streams produced:** `caracal.audit.events`, `caracal.sessions.revoke`.
- **Trust model:** the only token issuer in the system. STS verifies
  application identity on every exchange; no other service mints Caracal JWTs.

## Gateway — `services/gateway`

Stateless reverse proxy in front of MCP / HTTP resource servers.

- **Port:** 8081 (immutable; `loadConfig` rejects any other PORT).
- **Endpoints:** `/health`, `/ready`, plus the catch-all proxy handler.
- **Owns:** SSRF guard, JWKS cache, JTI replay tracker, in-memory revocation
  cache, per-chunk SSE streaming.
- **Database:** read-only consumer of `gateway_resource_bindings` (polled every
  30 s).
- **Streams consumed:** `caracal.sessions.revoke` via consumer group.
- **Trust model:** never the trust root. Verifies bearer signatures locally
  against the per-zone JWKS; defers all authority decisions to STS.

## Agent Coordinator — `apps/agent-coordinator`

Control-plane service for agent sessions and delegations.

- **Port:** 8080.
- **Endpoints:** session lifecycle (`/sessions`, `/sessions/{id}`),
  delegation edges, identity binding for inbound A2A traffic.
- **Owns:** agent session state, delegation graph, A2A transport.
- **Trust model:** not on the data path. Calls through it never expose
  provider credentials; those live in STS+gateway only.

## Audit — `services/audit`

Append-only consumer of the `caracal.audit.events` stream.

- **Owns:** audit persistence, retention windows, queryable history.
- **Trust model:** read-only with respect to runtime authority. Audit data is
  used for forensics and compliance, not for live policy decisions.

## Operational notes

- **Latest stable runtimes:** Go 1.26 across all Go services; net/http only
  (no external HTTP framework in the gateway).
- **Dev escape hatches:** `INSECURE_HTTP` and `INSECURE_STS` are forbidden
  unless `CARACAL_ENV=dev`; same gate applies to `ALLOW_PRIVATE_UPSTREAMS`.
- **Replay tracker default:** `JTI_FAIL_OPEN=false`. Set true only to allow
  traffic when Redis is unreachable; this widens the replay window for
  per-call tokens.
