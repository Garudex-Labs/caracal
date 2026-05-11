---
title: Threat Model
description: Caracal's security model, trust boundaries, threats, and mitigations.
---

Caracal's authority model is built on three rules: STS is the only token issuer,
the gateway is the only path that handles vaulted provider credentials, and the
audit pipeline is append-only. Every threat in this document is evaluated
against those rules.

## Trust Boundaries

| Boundary | Trusted | Untrusted |
|---|---|---|
| App ↔ Coordinator | Application identity (signed assertion or shared secret) | Caller-supplied claims about other principals |
| App ↔ Gateway | Caracal subject token (verifiable JWT) | All `X-Caracal-*` routing headers, `X-Forwarded-*` |
| Gateway ↔ STS | Mutual TLS or pinned in-cluster network | Anything in the request body the caller controls |
| STS ↔ Database | Schema-bound queries, transactional writes | None (DB is the authority store) |
| Gateway ↔ Upstream | URL+credentials minted by STS for this single call | Whatever the upstream returns |

The gateway is **never** the trust root. STS is. The gateway converts a
long-lived ambient subject token into a short-lived per-call credential, and
forwards the request only to upstreams STS authorizes.

## Threats and Mitigations

### T1 — Stolen subject token

**Threat:** an attacker exfiltrates a subject token from app memory, logs, or a
proxy.

**Mitigations:**

- Subject tokens are JWTs signed by STS; tampering invalidates them.
- Revocation propagates over Redis Streams to every gateway within a poll
  interval; in-flight SSE streams truncate on revoke.
- The gateway pre-flight-rejects bearers within 35 s of expiry to keep the
  STS-exchange window narrow.
- Tokens are never logged; only `tokenFingerprint` (8-byte SHA-256 prefix)
  appears in structured logs.

**Residual risk:** the window between leak and revocation is wall-clock-bound.
Mitigated further by deploying mTLS between SDK and gateway (operator-owned).

### T2 — Replay of a per-call token

**Threat:** an attacker captures a per-call token mid-flight and replays it.

**Mitigations:**

- Every per-call JTI is recorded in Redis with TTL=time-until-exp; second use
  is rejected and emits a `replay_detected` audit event.
- Ambient session tokens are explicitly excluded — they are reusable by design.
- The replay tracker is **fail-closed by default** (`JTI_FAIL_OPEN=false`); a
  flaky Redis cannot widen the replay window.

### T3 — Header spoofing

**Threat:** the caller injects `X-Caracal-Client-ID`, `X-Forwarded-For`, or
similar to impersonate another principal or pollute audit data.

**Mitigations:**

- The gateway **rejects** any inbound `X-Caracal-Client-ID`; application_id is
  bound by the gateway's resource binding row.
- All `X-Caracal-*` routing headers are stripped before forwarding upstream.
- `X-Forwarded-For/Proto/Host` are **replaced** (not appended), so caller
  values cannot leak into the first XFF entry that upstreams typically read.

### T4 — SSRF via crafted upstream URL

**Threat:** a compromised STS or DB row directs the gateway at
`127.0.0.1`, link-local, CGNAT, or cloud-metadata IPs.

**Mitigations:**

- `upstreamGuard` allowlists hostnames and refuses private/loopback/link-local/
  CGNAT/metadata IPs by default.
- DNS is re-resolved at dial time to close the TOCTOU window between the
  initial check and the actual TCP connect (DNS rebinding defense).
- `ALLOW_PRIVATE_UPSTREAMS=true` is gated behind `CARACAL_ENV=dev` only.

### T5 — Path traversal

**Threat:** `..` or `.` segments in the request path coerce the gateway into
calling an admin endpoint on the upstream.

**Mitigations:** rejected before STS exchange; 400 with `X-Request-Id` echoed.

### T6 — Hop-by-hop header smuggling

**Threat:** `Connection: X-Hop-Custom` or `Proxy-Authorization` smuggled
through the gateway.

**Mitigations:** RFC 7230 hop-by-hop headers are stripped on both inbound and
outbound paths.

### T7 — Audit poisoning via unverified pre-flight claims

**Threat:** the gateway reads `exp`, `jti`, `sid` from the bearer before
signature verification, so a caller can stuff attacker-controlled values that
land in `replay_detected` events.

**Mitigations:** the gateway verifies the bearer signature locally against a
per-zone JWKS cache (`jwks.go`) before any audit log uses claim values. JTI
and sid checks run after verification. STS exchange remains the authority
trust root.

### T8 — Streaming token leak

**Threat:** an SSE stream stays open after the underlying session is revoked.

**Mitigations:** `streamCopy` re-reads the revocation cache between every
chunk and closes the upstream body on revoke. Per-chunk flush keeps the
window to one chunk.

### T9 — Provider credential exposure

**Threat:** an OAuth or API-key credential leaks from app code, logs, or a
network capture.

**Mitigations:** provider credentials never leave STS+gateway. The SDK never
sees them. STS encrypts them at rest with a zone-scoped ZEK, hands them to
the gateway only inside an `UpstreamDirective` over the request-bound
exchange, and the gateway substitutes them into `Authorization` only on the
outbound leg.

### T10 — Bypassing the gateway

**Threat:** an SDK or app calls an upstream directly, skipping the gateway and
the audit/revocation guarantees.

**Mitigations:** the SDKs (TypeScript, Go, Python) all rewrite outbound HTTP
requests through `gatewayUrl` when the URL matches a configured
`ResourceBinding`. Calls to unregistered hosts go direct — that is a
deliberate trade-off and is covered under [routing rules](/architecture/system).

**Residual risk:** registration drift between SDK env (`CARACAL_RESOURCES`)
and the gateway DB table is operator-owned. A single source of truth via the
coordinator is on the roadmap.

## Out of scope (pushed to operator policy)

- mTLS between SDK and gateway. Caracal does not require it; deploying behind a
  service mesh is the standard recommendation.
- Upstream identity attestation. The gateway trusts the URL STS hands it, gated
  by the SSRF allowlist.
- Cross-zone resource collisions. The schema scopes `resource_identifier`
  uniquely; multi-tenant routing across zones is single-zone today.
