# Threat Model

## Purpose

This model identifies what can go wrong, who owns the response, what mitigation is expected, and how maintainers verify the system remains safe.

## Scope

In scope:

- `apps/api`: Fastify control plane for zones, applications, resources, providers, policies, grants, invitations, teams, step-up challenges, and admin audit.
- `apps/coordinator`: Fastify agent lifecycle, delegation, invocation, TTL, retention, and outbox service.
- `services/sts`: OAuth 2.0 token exchange, ES256 signing, JWKS, policy evaluation, step-up, replay, revocation, and audit emission.
- `services/gateway`: reverse proxy that exchanges inbound credentials with STS, validates bindings, enforces replay/revocation checks, and forwards authorized requests.
- `services/audit`: Redis Streams consumer, append-only PostgreSQL audit ledger, tamper checks, retention, and Parquet export.
- `apps/control`: optional control invocation endpoint gated by explicit enablement, ES256 bearer auth, per-resource scope checks against the engine catalog, JTI replay, rate limits, and audit.
- `services/coordinator-relay`: Redis Streams lifecycle relay with signature verification and dedupe.
- `packages/*`: shared identity, OAuth, revocation, transport, connector, SDK, admin, and core libraries.
- `infra/docker`: local-dev and runtime Compose stacks, secrets, hardened containers, PostgreSQL, Redis, migrations, and health checks.

Out of scope: enterprise-only code, customer deployments outside the provided deployment model, external identity providers, external upstream services, host OS hardening beyond the Compose controls, and private incident details.

## Assets / What we are protecting

| Asset | Why it matters | Primary owners |
|---|---|---|
| Agent and application authority | Controls what autonomous agents can access and do. | API, STS, coordinator, gateway maintainers |
| Policies, grants, zones, resource bindings | Define authorization boundaries and proxy destinations. | API, STS, gateway maintainers |
| Signing keys, KEKs, admin tokens, client secrets, Redis/PostgreSQL credentials | Compromise enables impersonation, data access, or service takeover. | API, STS, infra maintainers |
| Tokens, sessions, JTIs, revocations, step-up state | Enforce identity, replay prevention, expiry, and emergency denial. | STS, gateway, coordinator maintainers |
| Audit events and chain state | Provide evidence for authorization, incidents, and tamper detection. | Audit, API, STS, gateway, coordinator, control maintainers |
| Redis Streams and outbox rows | Carry lifecycle, invalidation, audit, and revocation events. | API, coordinator, STS, audit, relay maintainers |
| Container images, installers, release artifacts, dependency lockfiles | Define what users execute. | Release and infra maintainers |

## Trust Boundaries

| Boundary | Decision |
|---|---|
| User, Console, and admin clients to API/coordinator | Treat all request input, headers, tokens, and trace data as untrusted; validate with schemas and authorization before mutation. |
| API/coordinator to PostgreSQL and Redis | PostgreSQL is the durable source of truth; Redis is transport/cache state and must not override database authority. |
| STS to policy, signing keys, sessions, and step-up state | STS is the token-issuing choke point and must fail closed on policy, key, replay, revocation, and signing errors. |
| Gateway to upstream resources | Gateway is the runtime enforcement point; it must exchange credentials per request, strip routing headers, enforce safe upstreams, and never trust caller-supplied destinations without bindings. |
| Control automation to API/coordinator | Control holds service-side admin credentials and translates STS-issued remote scopes into admin API calls; remote authority must remain zone-bound unless an operation is explicitly global and separately governed. |
| Service producers to Redis Streams consumers | Runtime streams require HMAC signing; consumers must dedupe, verify origin where configured, and acknowledge only after durable handling. |
| Audit producers to audit service | Audit records must not contain plaintext secrets or claims; the audit ledger must be append-only and tamper-evident. |
| Runtime containers to host | Published service ports bind to localhost; containers run with dropped capabilities, read-only filesystems where applicable, tmpfs scratch, secrets files, health checks, and bounded resources. |
| OSS repository to enterprise code | The open-source product must not import, reference, or rely on enterprise-only code or controls. |

## Assumptions

- rc and stable are the security baseline; dev defaults are not production controls.
- PostgreSQL, Redis, and service secrets are reachable only by the intended local/runtime stack.
- Operators generate, store, rotate, and protect Docker secrets and admin tokens outside Git.
- STS-issued ES256 tokens are the only accepted authority for runtime service calls that require bearer auth.
- OPA/Rego remains the sole policy engine for STS authorization decisions.
- Gateway is the only supported path for proxied upstream access.
- Audit events may be delayed during dependency outages, but accepted events must become durable or remain recoverable.
- External upstreams, registries, package mirrors, S3-compatible export targets, and user-provided provider data are untrusted.
- Maintainers can challenge any assumption during design review, incident response, or release hardening.

## What Can Go Wrong

| ID | Threat | Target area | Primary owner |
|---|---|---|---|
| T1 | A request bypasses auth, zone ownership, scope checks, or input schemas and mutates control-plane state. | `apps/api`, `apps/coordinator` | API/coordinator maintainers |
| T2 | STS issues a token with excessive authority because policy, grant, session, step-up, replay, or key validation fails open. | `services/sts`, policy/grant storage | STS maintainers |
| T3 | Gateway forwards a request to an unsafe or unintended upstream, leaks routing headers, reuses authority, or misses replay/revocation state. | `services/gateway`, resource bindings | Gateway maintainers |
| T4 | Agent lifecycle or delegation state becomes inconsistent through races, missing transactions, outbox gaps, or relay replay. | `apps/coordinator`, `services/coordinator-relay`, Redis Streams | Coordinator/relay maintainers |
| T5 | Secrets or sensitive claims appear in logs, API responses, audit payloads, metrics, config, fixtures, release artifacts, or examples. | All services, apps, packages, infra | Owning component maintainer |
| T6 | Audit evidence is missing, forgeable, mutable, unverifiable, or loses ordering during dependency failures. | `services/audit`, audit producers, Redis Streams, PostgreSQL | Audit and producer maintainers |
| T7 | Redis Streams messages are forged, replayed, dropped, processed twice, or acknowledged before durable handling. | STS, API, coordinator, audit, relay, gateway revocation consumers | Stream producer/consumer maintainers |
| T8 | Runtime availability degrades enough to disable enforcement, token exchange, audit, revocation, or control invocation. | Compose stack, PostgreSQL, Redis, STS, gateway, audit, control | Infra and service maintainers |
| T9 | Optional control invocation becomes a command execution path outside `engine.dispatch`, without audit, or with remote scopes that expand zone-bound tokens into global admin authority. | `apps/control`, `packages/engine`, `packages/admin` | Control maintainers |
| T10 | A compromised dependency, generated artifact, installer, image, or release process ships malicious or vulnerable code. | `package.json`, `pnpm-lock.yaml`, Go modules, Dockerfiles, installers, releases | Release maintainers |
| T11 | Security boundaries drift when new services, ports, packages, transports, provider integrations, or enterprise references are added. | Repo architecture and governance | Maintainers approving the change |

## Mitigations / Actions

| Threats | Required mitigation | Target area | Owner |
|---|---|---|---|
| T1 | Keep auth plugins/hooks mandatory for protected routes; validate every request with schemas before database or Redis access; enforce zone, application, team, and scope guards at mutation points. | API/coordinator routes | API/coordinator maintainers |
| T2 | Keep STS deny-by-default; reject partial policy results; verify stored ownership/session state; require step-up where configured; fail closed on policy, key, replay, revocation, and signing errors. | STS exchange, OPA, key cache, session and grant queries | STS maintainers |
| T3 | Perform fresh STS exchange per proxied request; strip hop-by-hop and `X-Caracal-*` headers; enforce request size/timeouts; block private, loopback, link-local, CGNAT, and metadata upstreams unless explicitly allowed. | Gateway proxy and safety guard | Gateway maintainers |
| T4 | Use transactions and advisory locks for graph mutations; publish lifecycle/delegation/invalidation events through the outbox; keep relay dedupe and idle-claim behavior bounded. | Coordinator DB writes, jobs, relay | Coordinator/relay maintainers |
| T5 | Resolve secrets from secret files; redact known sensitive log paths; never return plaintext key material, client secrets, bearer tokens, subject claims, database URLs, or Redis URLs. | Logging, responses, audit payloads, config | Owning component maintainer |
| T6 | Keep `audit_events` append-only; sign audit chain entries with HMAC when configured; acknowledge streams only after insert, duplicate handling, or DLQ routing; run tamper sweeps and retention/export jobs under leader locks. | Audit service and producers | Audit maintainers |
| T7 | Require stream HMAC keys in rc and stable; verify producer signatures where configured; dedupe stream messages; leave transient failures in the pending-entry list for reclaim. | Redis Streams producers and consumers | Stream producer/consumer maintainers |
| T8 | Preserve bounded request bodies, timeouts, rate limits, health/readiness checks, resource limits, restart policies, and localhost-only port bindings; fail readiness when PostgreSQL, Redis, STS, or required upstreams are unavailable. | Compose, service servers, config | Infra and service maintainers |
| T9 | Keep control disabled unless `CARACAL_CONTROL_ENABLED=true`; allow only `POST /v1/control/invoke`; require the per-resource `control:<command>:<verb>` scope derived from the engine catalog; validate commands through `engine.dispatch`; enforce zone binding before any admin call that can affect zone-scoped state, and require an explicit global-control model for zone CRUD or other global operations; audit accepted and rejected requests; never shell out. | Control service (`apps/control`), engine catalog (`packages/engine`), and admin client (`packages/admin`) | Control maintainers |
| T10 | Keep lockfiles and module sums reviewed; publish versioned images and archives only from trusted release paths; verify installers, Dockerfiles, and generated artifacts do not embed secrets or uncontrolled network fetches. | Release tooling and dependencies | Release maintainers |
| T11 | Update this model, service instructions, tests, and governance when boundaries change; reject OSS changes that depend on enterprise-only code or undocumented controls. | Architecture and governance | Reviewing maintainers |

## Validation / How to Verify

| Threats | Verification |
|---|---|
| T1 | Run API/coordinator route, security, property, fuzz, and contract tests; review new routes for auth hooks, schema validation, zone guards, and admin audit coverage. |
| T2 | Run `go test ./services/sts/...`; include negative tests for policy denial, partial evaluation, bad keys, revoked sessions, replayed JTIs, expired step-up, and malformed JWT claims. |
| T3 | Run `go test ./services/gateway/...`; include SSRF, metadata IP, private network, header stripping, request-size, timeout, replay, revocation, and STS-failure cases. |
| T4 | Run coordinator tests and relay tests; verify graph mutations use transactions/locks and lifecycle events are produced through outbox or relay-safe paths. |
| T5 | Review logs, metrics, API responses, audit events, fixtures, and generated artifacts for secrets; confirm redaction paths cover new credential fields. |
| T6 | Run `go test ./services/audit/...`; verify append-only writes, HMAC chain checks, tamper mismatch metrics, DLQ paths, retention rotation, and export behavior. |
| T7 | Run stream consumer tests for valid signature, missing signature in runtime, duplicate message, transient dependency failure, PEL reclaim, and DLQ routing. |
| T8 | Run service readiness checks in the Compose stack; confirm dependency outages return unavailable status and do not produce success-shaped responses. |
| T9 | Run `pnpm --dir apps/control test` and `pnpm --dir packages/engine test`; verify disabled startup, missing scope, hidden-command refusal, invalid flags, replay, rate limit, upstream failure, audit emission, zone-bound dispatch, and explicit denial or separate governance of global zone operations. |
| T10 | Run dependency review, lockfile diff review, release smoke tests, image build checks, and installer/archive secret scans before publishing. |
| T11 | During review, compare changed files against this model, `go.work`, workspace packages, service instructions, and Compose boundaries. |

## Review Triggers

Review and update this threat model when any of the following occurs:

- Authorization, policy, token, key, revocation, replay, step-up, or scope logic changes.
- API, coordinator, gateway, STS, audit, control, relay, transport, connector, or SDK boundaries change.
- A new service, route, package, stream, database table, port, container, secret, provider integration, export target, or release artifact is introduced.
- Compose, Dockerfile, installer, image registry, mode, secret handling, or deployment defaults change.
- Dependency updates affect auth, crypto, HTTP, parsing, policy, database, Redis, build, installer, or release behavior.
- A security incident, near miss, audit finding, bug bounty report, or operational outage exposes an unmodeled risk.
- Enterprise isolation, licensing, or shared-interface assumptions change.
- Before each major release and after any high-risk dependency or platform update.

This threat model and the incident response process are best-effort open-source governance artifacts; Caracal is provided under the Apache License 2.0 without warranties or liability as stated in [`LICENSE`](../LICENSE). For contractual assurances, support, or enterprise terms, contact Caracal Enterprise at [contact@caracal.run](mailto:contact@caracal.run).
