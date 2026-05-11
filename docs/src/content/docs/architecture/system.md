---
title: System Overview
description: The major services and data flows behind Caracal.
pageType: architecture
concepts: []
relatedConcepts: [mandate, principal, zone, resource-binding]
keywords: [three-plane, coordinator, STS, gateway, request lifecycle, routing matrix, deployment, JWKS, revocation]
service: all
---

Caracal is split into three planes, each running as its own service.

## Planes

### Control plane — coordinator

Runs agent sessions, delegations, and identity binding. The SDK calls it for
`run`, `delegate`, and `bindFromHeaders`. It has no role on the data path.

### Authority plane — STS

The single token issuer. Every per-call credential the gateway forwards
upstream is minted here over RFC 8693. STS owns:

- Application authentication (signed assertions or shared secrets).
- Policy evaluation (OPA), including step-up challenges and quotas.
- Per-zone ES256 signing keys, exposed publicly via JWKS.
- Provider credential vault (OAuth tokens, API keys) encrypted with a per-zone
  ZEK.
- Audit pipeline ingress.

### Data plane — gateway

A stateless reverse proxy in front of MCP / HTTP resource servers. Receives
the inbound subject token, verifies its signature against the cached JWKS,
exchanges it with STS for a per-call credential, and forwards the request to
the upstream STS chose. The gateway never caches tokens or upstream
responses.

## Request lifecycle (gateway path)

1. SDK rewrites the outbound request through `gatewayUrl` and adds
   `X-Caracal-Resource: <rid>` plus the subject-token bearer.
2. Gateway runs pre-flight: bearer present, JWT shape parseable, not within
   35 s of expiry, no caller-supplied `X-Caracal-Client-ID`, no `..` in path.
3. Gateway resolves `(zone_id, application_id)` from
   `gateway_resource_bindings` (Postgres, polled every 30 s).
4. Gateway verifies the bearer signature against the JWKS cache for that zone.
5. JTI replay check (Redis SETNX, fail-closed by default).
6. Revocation check (in-memory cache fed by `caracal.sessions.revoke` Redis
   stream).
7. STS exchange: synchronous, no retry, no cache. Returns access token plus
   per-resource `UpstreamDirective`.
8. SSRF guard re-validates the upstream URL and re-resolves DNS at dial time.
9. Gateway strips hop-by-hop and `X-Caracal-*` headers, replaces `Authorization`
   with the credential STS chose, replaces (not appends) `X-Forwarded-*`,
   forwards the request.
10. Response is streamed back with per-chunk flush; on every chunk boundary the
    revocation cache is re-checked and the stream truncated on revoke.

## Routing matrix

| Call type | Through gateway? | Why |
|---|---|---|
| Tool call to a registered MCP/HTTP resource | required | Only path STS will mint per-call creds for |
| Provider call (OpenAI, Anthropic, …) registered as a resource | required | Vaulted provider creds substituted in `auth_mode=provider_*` |
| Provider call **not** registered | bypasses | SDK has no binding; app calls direct with its own creds |
| Direct call to a Caracal-aware backend | required if registered | Registration drives gateway routing |
| MCP via `transport-mcp` | through | Transport delegates to SDK fetch |
| Agent-to-agent (A2A) | not gateway | A2A goes via coordinator + delegation tokens |
| Coordinator API (`run`, `delegate`, …) | bypasses | Gateway has no control-plane role |
| STS `/oauth/2/token` | bypasses | Gateway is the caller |
| Health, audit, internal admin | bypasses | Different services |
| SSE / chunked streaming | through | Per-chunk flush + per-chunk revocation re-check |

Registration is opt-in. Any upstream not in the SDK's binding list and not in
the gateway's DB table goes direct; those calls live outside Caracal's audit
and revocation guarantees by operator choice.

## Cross-service contracts

- **JWKS:** STS publishes `/.well-known/jwks.json?zone_id=<zone>` (per-zone
  ES256 keys). Gateway caches with 5-minute TTL and a forced miss-refresh on
  unknown kid (rate-limited 30 s).
- **Token exchange:** RFC 8693 over `POST /oauth/2/token`. Gateway sends the
  inbound bearer as `subject_token`, the resolved `(zone_id, application_id)`
  pair, and the requested resource. STS returns `TokenResponse` with
  `access_token` and `Upstreams[rid]` directives.
- **Revocation:** STS publishes session revocations to the
  `caracal.sessions.revoke` Redis stream. Gateways consume via consumer groups
  and feed an in-memory cache.
- **Audit:** `replay_detected`, `policy_denied`, and other events land on the
  `caracal.audit.events` Redis stream. The audit service consumes and persists.

## Local ports

OSS services use the 808x range. The enterprise stack uses 8090–8099.

| Service | Port |
|---|---|
| coordinator | 8080 |
| gateway | 8081 |
| sts | 8082 |
| audit | 8083 |

These are immutable by config: `loadConfig` rejects any other PORT for the
gateway and STS.

## Deployment shapes

- **Side-car:** one gateway per application pod. Lowest blast radius; highest
  pod count.
- **Central proxy:** one gateway per cluster. Lower pod count; broader blast
  radius. Use mTLS at the SDK-gateway hop in this shape.
- **No gateway:** valid only when the deployment never registers provider
  credentials and the operator accepts that calls live outside the audit and
  revocation guarantees.
