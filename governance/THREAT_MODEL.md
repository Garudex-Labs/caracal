# Threat Model

## Purpose

This model identifies what can go wrong, who owns the response, what mitigation is expected, and how maintainers verify the system remains safe.

## Assurance Case

**Claim:** Caracal's security requirements - pre-execution authority, deny-by-default authorization, tamper-evident audit, secret confidentiality, and a trusted release path - are met for the in-scope open-source product.

The argument rests on four pillars, each substantiated by the sections and code referenced below.

1. **Threat model.** The threats are enumerated as T1–T14 in [What Can Go Wrong, and How Caracal Handles It](#what-can-go-wrong-and-how-caracal-handles-it). Each entry pairs the problem an adversary would exploit with the controls Caracal enforces against it, how maintainers verify those controls, and who owns them. [Review Triggers](#review-triggers) keeps the model current as boundaries change.

2. **Trust boundaries.** Boundaries are identified explicitly in [Trust Boundaries](#trust-boundaries): browser→BFF, BFF→API/coordinator, clients→API/coordinator, API/coordinator→PostgreSQL/Redis, STS→keys/policy/sessions, gateway→upstreams, control→API/coordinator, LLM providers→Operator, producers→stream consumers, audit producers→audit service, containers→host, and OSS→enterprise. Every boundary states what is untrusted and where mediation occurs.

3. **Secure design principles are applied.** The design embodies the standard principles, and each is enforced in code:
   - _Deny-by-default / fail-safe defaults:_ STS rejects partial policy results and fails closed on policy, key, replay, revocation, and signing errors; control is disabled unless `CARACAL_CONTROL_ENABLED=true`; stream and audit HMAC keys are required in `rc`/`stable` (T2, T6, T7, T9).
   - _Complete mediation:_ the gateway performs a fresh STS exchange per proxied request and validates bindings before dispatch; protected routes require mandatory auth hooks (T1, T3).
   - _Least privilege:_ STS issues narrowly scoped ES256 mandates; control enforces per-resource `control:<command>:<verb>` scopes; admin tokens can be zone-scoped and read-only; the Operator's identities are role-scoped and trait-bounded (T2, T9, T12, T14).
   - _Defense in depth:_ application-layer zone and account guards are backed by row-level security, request size/timeout limits, SSRF egress blocking, and hardened containers (T1, T3, T8, T12).
   - _Separation of privilege and economy of mechanism:_ OPA/Rego is the sole policy engine, the gateway is the only proxied-access path, and STS-issued tokens are the only accepted runtime authority ([Assumptions](#assumptions)).

4. **Common implementation weaknesses are countered.** The mitigations map to the recognized weakness classes, and each countermeasure is tested:
   - _Injection / malformed input:_ schema validation (zod, OPA input contracts) on every untrusted request before database or Redis access (T1; route, property, and fuzz tests).
   - _Broken authentication / token confusion:_ ES256 verification pins `WithValidMethods`, with issuer, audience, expiry, replay (JTI), and revocation checks (T2; STS negative tests).
   - _SSRF and unsafe egress:_ the gateway blocks always-dangerous ranges at both the pre-flight check and the connection-time dial, and no gateway HTTP client follows redirects (T3; gateway SSRF and redirect tests).
   - _Sensitive data exposure:_ secrets resolve from files, logs and responses redact key material and credentials, and the audit ledger never stores plaintext claims (T5, T6; redaction and audit tests).

- _Retry and replay confusion:_ Coordinator creation retries bind HMAC-digested operation identifiers to the authenticated scope and a canonical request fingerprint; changed-payload reuse is rejected, and SDK docs distinguish creation replay from arbitrary callback or downstream-effect execution (T4, T5; idempotency contract tests).
- _Tampering / integrity loss:_ append-only audit writes with a per-zone HMAC chain, success responses gated on durable audit persistence, HMAC-signed Redis stream messages, and dedupe with ack-after-durable handling (T6, T7, T12; audit and stream tests).
- _Supply-chain compromise:_ reviewed lockfiles and module sums, CodeQL/Trivy/Scorecard scanning, and signed, provenance-attested release artifacts verifiable per [Verify a Release](https://caracal.run/security/verify-releases/) (T10; release checks).

Residual, knowingly-open items are tracked in [Known Limits and How Caracal Contains Them](#known-limits-and-how-caracal-contains-them) so the assurance case stays honest about its current limits and the containment already in place.

## Scope

In scope:

- `apps/api`: Fastify control plane for zones, applications, resources, providers, policies, policy sets, grants, step-up challenges, policy templates, admin tokens, audit retention, admin audit, and the AI Operator, plus the optional control invocation plugin (`apps/api/src/control`) gated by explicit enablement, ES256 bearer auth, per-resource scope checks against the engine catalog, JTI replay, rate limits, and audit.
- `apps/coordinator`: Session lifecycle, Delegation, invocation, TTL, retention, outbox, and the Redis Streams lifecycle relay with signature verification and dedupe.
- `apps/auth`: web backend-for-frontend - operator sign-in, sessions, and the authenticated proxy that carries console traffic to the API and coordinator.
- `apps/web`: web console SPA, served same-origin by the BFF in production.
- `services/sts`: OAuth 2.0 token exchange, ES256 signing, JWKS, policy evaluation, step-up, replay, revocation, and audit emission.
- `services/gateway`: reverse proxy that exchanges inbound credentials with STS, validates bindings, enforces replay/revocation checks, and forwards authorized requests.
- `services/audit`: Redis Streams consumer, append-only PostgreSQL audit ledger, tamper checks, retention, and Parquet export.
- `packages/*`: shared identity, OAuth, revocation, transport, connector, SDK, admin, engine, and core libraries.
- `infra/*`: Compose and Helm stacks, secrets handling, hardened containers, PostgreSQL migrations, Redis, and health checks.

Out of scope: enterprise-only code, customer deployments outside the provided deployment model, external identity providers, external upstream services and LLM providers themselves, host OS hardening beyond the shipped controls, and private incident details.

## Assets / What we are protecting

| Asset                                                                          | Why it matters                                                       | Primary owners                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Agent and application authority                                                | Controls what autonomous agents can access and do.                   | API, STS, coordinator, gateway maintainers                 |
| Policies, grants, zones, accounts, resource bindings                           | Define authorization boundaries, ownership, and proxy destinations.  | API, STS, gateway maintainers                              |
| Signing keys, KEKs, admin tokens, client secrets, Redis/PostgreSQL credentials | Compromise enables impersonation, data access, or service takeover.  | API, STS, infra maintainers                                |
| Tokens, sessions, JTIs, revocations, step-up state                             | Enforce identity, replay prevention, expiry, and emergency denial.   | STS, gateway, coordinator maintainers                      |
| Audit events and chain state                                                   | Provide evidence for authorization, incidents, and tamper detection. | Audit, API, STS, gateway, coordinator, control maintainers |
| Operator conversations, plans, and plan secrets                                | Drive governed mutations and hold operator-supplied credentials.     | API maintainers                                            |
| Redis Streams and outbox rows                                                  | Carry lifecycle, invalidation, audit, and revocation events.         | API, coordinator, STS, audit, relay maintainers            |
| Container images, installers, release artifacts, dependency lockfiles          | Define what users execute.                                           | Release and infra maintainers                              |

## Trust Boundaries

| Boundary                                                 | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser and the web backend-for-frontend (BFF)           | The browser holds only a session cookie; the BFF (`apps/auth`) holds all privileged credentials server-side and serves the SPA same-origin. Treat all browser input as untrusted: enforce the request `Origin` on every state-changing proxied or custom call, set hardened security headers and `Secure`/`SameSite` cookies, rate-limit credential endpoints, and never expose tokens or internal error detail to the browser. Only allowlisted identities (the host-managed `caracal allowlist` file, deny-by-default in production) may register and sign in. |
| Web BFF to API/coordinator                               | The BFF translates a signed-in session into admin-API calls carried by derived console read/write tokens, asserting the signed-in account per request in a signed `x-caracal-account` header. It must validate the normalized proxied path stays within the intended surface, propagate request correlation, and cancel upstream work when the client disconnects. The API independently verifies the assertion and enforces per-account zone ownership.                                                                                                         |
| Admin and automation clients to API/coordinator          | Treat all request input, headers, tokens, and trace data as untrusted; validate with schemas and authorization before mutation.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| API/coordinator to PostgreSQL and Redis                  | PostgreSQL is the durable source of truth; Redis is transport/cache state and must not override database authority.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| STS to policy, signing keys, sessions, and step-up state | STS is the token-issuing choke point and must fail closed on policy, key, replay, revocation, and signing errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Gateway to upstream resources                            | Gateway is the runtime enforcement point; it must exchange credentials per request, strip routing headers, enforce safe upstreams, and never trust caller-supplied destinations without bindings.                                                                                                                                                                                                                                                                                                                                                                |
| Control automation to API/coordinator                    | Control holds service-side admin credentials and translates STS-issued remote scopes into admin API calls; remote authority must remain zone-bound unless an operation is explicitly global and separately governed.                                                                                                                                                                                                                                                                                                                                             |
| LLM providers to the AI Operator                         | Model output is untrusted input. It may only propose actions; every mutation passes plan approval, execution-time authority checks, and the same governed control path as any other caller.                                                                                                                                                                                                                                                                                                                                                                      |
| Service producers to Redis Streams consumers             | Runtime streams require HMAC signing; consumers must dedupe, verify origin where configured, and acknowledge only after durable handling.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Audit producers to audit service                         | Audit records must not contain plaintext secrets or claims; the audit ledger must be append-only and tamper-evident.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Runtime containers to host                               | Published service ports bind to localhost; containers run with dropped capabilities, read-only filesystems where applicable, tmpfs scratch, secrets files, health checks, and bounded resources.                                                                                                                                                                                                                                                                                                                                                                 |
| OSS repository to enterprise code                        | The open-source product must not import, reference, or rely on enterprise-only code or controls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Assumptions

- rc and stable are the security baseline; dev defaults are not production controls.
- PostgreSQL, Redis, and service secrets are reachable only by the intended local/runtime stack.
- Operators generate, store, rotate, and protect Docker secrets and admin tokens outside Git.
- STS-issued ES256 tokens are the only accepted authority for runtime service calls that require bearer auth.
- OPA/Rego remains the sole policy engine for STS authorization decisions.
- Gateway is the only supported path for proxied upstream access.
- Audit events may be delayed during dependency outages, but accepted events must become durable or remain recoverable.
- External upstreams, registries, package mirrors, S3-compatible export targets, user-provided provider data, and LLM model output are untrusted.
- Maintainers can challenge any assumption during design review, incident response, or release hardening.

### Known Limits and How Caracal Contains Them

These are the consciously-accepted limits of the open-source product. Each names the limit honestly, the containment Caracal already enforces, and the path to closing it.

- **Row-level security is enforced for service sessions, but the zone sentinel is cooperative.**
  - _The limit._ Services connect as dedicated non-owner roles (`NOBYPASSRLS`, per-table grants), so `zone_isolation` policies apply to every service session; the administrative login is reserved for migrations and restore tooling. The policies, however, admit a `'*'` sentinel that any session may set on its own connection, so database-level zone isolation backstops application bugs rather than a fully compromised service process.
  - _How Caracal contains it._ The control plane binds a per-request `caracal.zone_id` for zone-scoped actors and application-layer zone and account guards mediate every mutation (T1); data-plane services, which are cross-zone by design, set the sentinel once at connect. The migration job provisions each role's login credential from its own secret file, so no service holds the administrative password.
  - _Path to closure._ Move sentinel assignment behind a `SECURITY DEFINER` gate or per-zone database roles so a compromised service session cannot widen its own scope.

- **A database writer can substitute an older sealed value for the same reference.**
  - _The limit._ Envelope authentication binds a secret to its logical location, not to its version, so an attacker with direct database write access can restore a previously valid envelope for the same reference without detection.
  - _How Caracal contains it._ Reaching this requires database write access, which already implies control over provider configurations, grants, and policy state; every envelope still authenticates its location, so substitution cannot move a secret between references, zones, or tables. Credential rotation invalidates superseded upstream secrets at the provider, independent of Caracal's storage.
  - _Path to closure._ Bind the row version into the envelope's associated data, trading the single-statement upsert for a read-verify-write cycle.

- **The master key transits process memory as ordinary allocations.**
  - _The limit._ `SECRET_STORE_KEK` arrives through file-backed environment resolution and is decoded per operation; Node and Go runtimes do not pin, lock, or reliably zero those allocations, so a memory-disclosure primitive against a service process can recover the key.
  - _How Caracal contains it._ Data keys are zeroized after each seal and open, decrypted values are wiped where the runtime allows, the KEK never reaches logs or the database, and weak keys are rejected at startup. A memory-disclosure primitive against the API or STS already implies access to plaintext secrets in flight, so the KEK adds no marginal authority within one deployment.
  - _Path to closure._ KMS- or HSM-held root keys with per-deployment unwrap, so process memory only ever holds short-lived data keys.

- **The bootstrap admin token can administer every zone.**
  - _The limit._ A single shared credential carries cross-zone authority.
  - _How Caracal contains it._ Day-to-day console traffic never presents the bootstrap token: reads use a derived read-capability token and writes a derived write token, both provisioned as independently revocable rows. Zone-scoped, per-operator tokens are mintable through the global-only `POST /v1/admin-tokens` route (with `GET`/`DELETE` for listing and revocation), and minting is never exposed on the remote control surface.
  - _Path to closure._ Operate exclusively with zone-scoped tokens and reserve the bootstrap token for break-glass.

- **Caracal cannot make arbitrary external side effects exactly once.**
  - _The limit._ A destination can commit a payment, message, or database change and the worker can crash before recording completion. On redelivery, neither Caracal nor any generic SDK can infer whether that external effect committed. Coordinator idempotency receipts prevent duplicate Coordinator resource creation; they do not suppress SDK callbacks or claim queue work.
  - _How Caracal contains it._ SDK retries automatically reuse a generated operation identifier. Explicit stable identifiers are optional and accepted only when a queue, webhook, workflow, or scheduler already provides one; keys are bounded and HMAC-digested, request fields are fingerprinted, and conflicting reuse fails closed. Documentation requires source leases plus destination-side idempotency, transactional inbox/outbox, durable workflow state, or reconciliation for external effects.
  - _Path to closure._ This is a distributed-systems boundary, not a missing generic algorithm. Integrations close it by carrying one stable operation id into a destination that supports deduplication or into a transaction shared with durable completion state.

- **`GATEWAY_STS_HMAC_KEY` is shared process-wide rather than per-zone.**
  - _The limit._ Compromise of this key affects gateway↔STS binding integrity across all zones, not just one.
  - _How Caracal contains it._ The key is delivered as a secret file, never logged or returned, required in rc/stable, and protects only the gateway↔STS binding channel; runtime authority itself remains independently ES256-signed and verified.
  - _Path to closure._ Derive per-zone binding keys so a single key compromise is contained to one zone.

- **The web BFF is an internet-facing single point holding admin-level authority.**
  - _The limit._ `apps/auth` is the only intended ingress, binds `0.0.0.0` in production, and holds the derived console tokens and the coordinator token server-side. A compromise of the auth process - a dependency vulnerability, an SSRF to its own loopback, or a session-gate bypass - yields console-level control-plane authority; and because the account assertion is signed with the deployment admin token, that same compromise can forge account identity.
  - _How Caracal contains it._ Registration is an authority boundary: every sign-up path rejects identities outside the host-managed allowlist file (`caracal allowlist`, mounted read-only into the container), and with no entries registration fails closed in production. The same allowlist is re-checked at session creation and on every proxied console request: a lock revokes the account's sessions within one request, a removal additionally erases its sign-in records, and every denial returns one uniform `access_denied` code so the browser cannot distinguish the cases. Erasure keys off an explicit `removed` tombstone written by the CLI - never off absence - so a missing or corrupted allowlist can deny but never destroy. Password sign-up is disabled in production by default; where re-enabled, a verified email is required before a session is issued, and only provider-verified identities auto-link. Every state-changing call is session-gated, origin-enforced, header-hardened, and rate-limited; proxied paths are re-validated against literal and percent-encoded traversal; tokens never reach the browser; and the API independently enforces per-account zone ownership fail-closed, so a single compromised operator session reaches only the zones that account owns.
  - _Path to closure._ Mint a zone-scoped per-operator admin token for each operator instead of shared console tokens, and keep the auth tier behind network controls so a process compromise is not internet-reachable.

- **Operator identity is only as strong as the configured sign-in path.**
  - _The limit._ A domain-suffix allowlist (`@example.com`) grants admin to any allowlisted-domain identity the configured identity provider will authenticate, so it is only as trustworthy as that provider and the operator's control over the domain. The BFF's session-validation cache is in-process with a seconds-long TTL, so under horizontal scaling revocation propagates per replica within that window.
  - _How Caracal contains it._ Social providers assert provider-verified emails, so an exact-email or domain allowlist over Google/GitHub binds admin to identities the provider vouches for. Password sign-up is off by default in production; email verification and password reset are SMTP-backed where configured. Better Auth rate limits persist in the database in production, so brute-force ceilings hold fleet-wide; sessions carry a fixed seven-day lifetime and never refresh; and the control plane independently verifies the admin credential on every call.
  - _Path to closure._ Prefer exact-email allowlists or provider org/domain restrictions over broad domain suffixes.

- **The Operator's control identities span every operator-governed zone.**
  - _The limit._ One set of reserved `caracal.sys` credentials can administer any zone that has granted operator administration, and plan authority is enforced at execution rather than already at approval.
  - _How Caracal contains it._ Cross-zone scope headers are honored only for the reserved operator subjects, and only toward existing, non-archived, non-reserved, non-isolated zones that explicitly granted operator governance. Credentials are generated in-process, auto-rotated, trait-bounded per role, and fail closed past their `control:expires` deadline; every execution re-checks step authority against the caller's capability set (T14).
  - _Path to closure._ Per-zone operator credentials, and authority evaluation at approval time in addition to execution.

## What Can Go Wrong, and How Caracal Handles It

Each threat (T1–T14) states the **problem** an adversary would exploit, **how Caracal handles it** in code and architecture, **how we verify** the control holds, and the **area and owner** accountable. The intent is to stay honest about the risk while making the enforced defense explicit.

### T1 - Control-plane request bypass

- **Problem.** A request tries to bypass auth, zone or account ownership, capability limits, scope checks, or input schemas to mutate control-plane state.
- **How Caracal handles it.** Auth hooks are mandatory on every protected route; each request is schema-validated before any database or Redis access; zone scope, account ownership, and read/write capability are enforced at a single auth choke point ahead of route handlers; and the reserved system zone is read-only to everyone except the internal provisioner.
- **How we verify.** API/coordinator route, security, property, fuzz, and contract tests; every new route is reviewed for auth hooks, schema validation, zone guards, and admin-audit coverage.
- **Area & owner.** `apps/api`, `apps/coordinator` - API/coordinator maintainers.

### T2 - STS over-issuance / fail-open

- **Problem.** STS could issue a token with excessive authority if policy, grant, session, step-up, replay, or key validation fails open.
- **How Caracal handles it.** STS is deny-by-default: it rejects partial policy results, verifies stored ownership/session state, requires step-up where configured, and fails closed on policy, key, replay, revocation, and signing errors.
- **How we verify.** `go test ./services/sts/...` with negative tests for policy denial, partial evaluation, bad keys, revoked sessions, replayed JTIs, expired step-up, and malformed JWT claims.
- **Area & owner.** `services/sts`, policy/grant storage - STS maintainers.

### T3 - Gateway egress / SSRF and authority reuse

- **Problem.** The gateway could forward a request to an unsafe or unintended upstream, leak routing headers, reuse authority, disclose upstream-internal targets, or miss replay/revocation state.
- **How Caracal handles it.** It performs a fresh STS exchange per proxied request, strips hop-by-hop and `X-Caracal-*` headers, and enforces request size and timeouts. Always-dangerous upstream ranges - link-local/cloud-metadata, multicast, unspecified, and their NAT64-embedded forms - are blocked at both the pre-flight check and the connection-time dial, closing the DNS-rebinding window. Loopback, RFC1918, unique-local, and CGNAT ranges are permitted by design: upstream URLs are operator-provisioned through the Control API and never client-supplied, and an optional egress allowlist pins the upstream host. No gateway HTTP client (proxy, STS exchange, JWKS fetch) follows redirects (`CheckRedirect` → `http.ErrUseLastResponse`), so a 3xx never carries injected credentials, the inbound bearer, or a JWKS fetch to an unvetted host. Responses are sanitized defensively: `Server`/framework banners and the `X-Caracal-Identity` mirror are stripped, and absolute or protocol-relative `Location`/`Content-Location`/`Refresh` targets are removed (relative references preserved), so an upstream cannot disclose its topology or steer a client off the enforced path.
- **How we verify.** `go test ./services/gateway/...` covering SSRF range blocking at both stages, the deliberate private/loopback allow policy, egress-allowlist enforcement, redirect non-following, response sanitization, header stripping, request-size, timeout, replay, revocation, and STS-failure cases.
- **Area & owner.** `services/gateway`, resource bindings - Gateway maintainers.

### T4 - Lifecycle / delegation state inconsistency

- **Problem.** Session lifecycle or Delegation state could become inconsistent through races, missing transactions, outbox gaps, or relay replay.
- **How Caracal handles it.** Graph mutations use transactions and advisory locks; lifecycle, Delegation, and invalidation events are published through the outbox; and relay dedupe and idle-claim behavior is bounded. Coordinator Session starts use durable receipts independent of mutable resource status: plaintext keys are HMAC-digested, requests are canonically fingerprinted, changed-input reuse returns `409`, and the Session mutation, outbox event, and receipt commit atomically. Terminating a Session subtree revokes the Delegations touching it and publishes their invalidations in the same transaction. Application-type authority records referenced by a terminated subtree are deliberately exempt from revocation - they authenticate a shared application credential rather than one Session - and their delegated authority dies with the subtree because STS refuses to mint over a terminated Session or a revoked Delegation. STS also requires an asserted Session to remain bound to the presented authority record.
- **How we verify.** Coordinator idempotency, route, retention, and relay tests confirm digest/fingerprint behavior, conflict detection, bounded keys, transactions/locks, outbox publication, receipt expiry, and subtree invalidation; STS negative tests reject Session/authority-record binding mismatches.
- **Area & owner.** `apps/coordinator`, Redis Streams - Coordinator maintainers.

### T5 - Secret / sensitive-claim exposure

- **Problem.** Secrets or sensitive claims could appear in logs, API responses, audit payloads, metrics, config, fixtures, release artifacts, or examples.
- **How Caracal handles it.** Secrets resolve from secret files; known sensitive log paths are redacted; and responses never return plaintext key material, client secrets, bearer tokens, subject claims, database URLs, or Redis URLs.
- **How we verify.** Review of logs, metrics, API responses, audit events, fixtures, and generated artifacts for secrets, confirming redaction covers any new credential fields.
- **Area & owner.** All services, apps, packages, infra - owning component maintainer.

### T6 - Audit integrity / ordering loss

- **Problem.** Audit evidence could be missing, forgeable, mutable, unverifiable, or lose ordering during dependency failures.
- **How Caracal handles it.** `audit_events` is append-only; chain entries are HMAC-signed when configured; streams are acknowledged only after insert, duplicate handling, or DLQ routing; and tamper sweeps plus retention/export jobs run under leader locks.
- **How we verify.** `go test ./services/audit/...` for append-only writes, HMAC chain checks, tamper-mismatch metrics, DLQ paths, retention rotation, and export behavior.
- **Area & owner.** `services/audit`, audit producers, Redis Streams, PostgreSQL - Audit and producer maintainers.

### T7 - Stream forgery / replay / double-processing

- **Problem.** Redis Streams messages could be forged, replayed, dropped, processed twice, or acknowledged before durable handling.
- **How Caracal handles it.** Stream HMAC keys are required in rc and stable; producer signatures are verified where configured; messages are deduped; and transient failures stay in the pending-entry list for reclaim.
- **How we verify.** Stream consumer tests for valid signature, missing signature in runtime, duplicate message, transient dependency failure, PEL reclaim, and DLQ routing.
- **Area & owner.** STS, API, coordinator, audit, relay, gateway revocation consumers - Stream producer/consumer maintainers.

### T8 - Availability degradation disabling enforcement

- **Problem.** Runtime availability could degrade enough to disable enforcement, token exchange, audit, revocation, or control invocation.
- **How Caracal handles it.** Bounded request bodies, timeouts, rate limits, health/readiness checks, resource limits, restart policies, and localhost-only port bindings are preserved; readiness fails when PostgreSQL, Redis, STS, or required upstreams are unavailable, so enforcement never silently returns success-shaped responses.
- **How we verify.** Service readiness checks in the Compose stack confirm dependency outages return unavailable status rather than success-shaped responses.
- **Area & owner.** Compose stack, PostgreSQL, Redis, STS, gateway, audit, control - Infra and service maintainers.

### T9 - Control invocation as a privilege-escalation path

- **Problem.** Optional control invocation could become a command-execution path outside `engine.dispatch`, run without audit, or use remote scopes that expand zone-bound tokens into global admin authority.
- **How Caracal handles it.** Control is disabled unless `CARACAL_CONTROL_ENABLED=true` and the runtime gate file is present; only `POST /v1/control/invoke` is allowed; each call requires the per-resource `control:<command>:<verb>` scope derived from the engine catalog, and issued scopes must stay within the caller's traits; commands are validated through `engine.dispatch` and never shelled out; zone binding is enforced before any admin call that affects zone-scoped state, and cross-zone scope headers are honored only for reserved operator identities toward operator-governed zones (T14); single-use JTIs, rate limits, and audit cover both accepted and rejected requests.
- **How we verify.** `pnpm --dir apps/api test` and `pnpm --dir packages/engine test` for disabled startup, missing scope, hidden-command refusal, invalid flags, replay, rate limit, upstream failure, audit emission, zone-bound dispatch, and refusal of unauthorized cross-zone scope targets.
- **Area & owner.** `apps/api/src/control`, `packages/engine`, `packages/admin` - Control maintainers.

### T10 - Supply-chain / release compromise

- **Problem.** A compromised dependency, generated artifact, installer, image, or release process could ship malicious or vulnerable code.
- **How Caracal handles it.** Lockfiles and module sums are reviewed; images and archives are published only from trusted release paths; installers, Dockerfiles, and generated artifacts are checked for embedded secrets and uncontrolled network fetches; and CodeQL, Trivy, and Scorecard scanning plus signed, provenance-attested artifacts make releases independently verifiable per [Verify a Release](https://caracal.run/security/verify-releases/).
- **How we verify.** Dependency review, lockfile diff review, release smoke tests, image build checks, and installer/archive secret scans before publishing.
- **Area & owner.** `package.json`, `pnpm-lock.yaml`, Go modules, Dockerfiles, installers, releases - Release maintainers.

### T11 - Boundary drift as the system grows

- **Problem.** Security boundaries could drift when new services, ports, packages, transports, provider integrations, or enterprise references are added.
- **How Caracal handles it.** This model, service instructions, tests, and governance are updated whenever boundaries change, and OSS changes that depend on enterprise-only code or undocumented controls are rejected.
- **How we verify.** During review, changed files are compared against this model, `go.work`, workspace packages, service instructions, and Compose boundaries.
- **Area & owner.** Repo architecture and governance - Maintainers approving the change.

### T12 - Admin-foothold expansion and audit evasion

- **Problem.** A compromised or shared admin credential, a spoofed internal header, an unauthenticated metrics/docs surface, or a missing or forgeable admin-audit record could expand a single control-plane foothold into broad multi-zone compromise - or hide the act.
- **How Caracal handles it.**
  - _Intent comes from identity, not headers._ Control-resource and internal-trait intent is derived from the authenticated actor scope, never from caller-supplied `X-Caracal-*` headers; the step-up approver is bound to the authenticated actor; and operator attribution fields are honored only for reserved operator subjects.
  - _Operational surfaces are closed by default._ The network-bound `/metrics` requires a metrics bearer (or refuses) in rc/stable, and OpenAPI/docs default off in published builds.
  - _Audit is fail-closed and tamper-evident._ A successful mutation is not reported as success until its admin-audit record is durably persisted; rows redact secret fields, OAuth `code`/`state`, and all query strings; and per-zone HMAC chains (advisory-locked head read and insert kept atomic) keep recorded evidence append-only and ordered.
  - _Blast radius is contained._ Read-only and zone-scoped admin tokens narrow authority at the auth choke point; derived console tokens keep the bootstrap token as break-glass; and each zone-scoped request binds Postgres `caracal.zone_id` so RLS is an enforceable backstop (see [Known Limits and How Caracal Contains Them](#known-limits-and-how-caracal-contains-them)).
- **How we verify.** `tests/typescript/unit/api/routes/{applications,resources,approvals,admin-tokens}.test.ts`, `api/app.test.ts`, `api/config.test.ts`, `api/admin-audit.test.ts`, and `api/zone-scope.test.ts`; confirm header spoofing cannot alter control-resource/trait visibility, the approval decider is the actor, `/metrics` denies unauthenticated access in published mode, docs default off when published, admin-token minting is global-only, a success response fails without a durable audit row, and admin-audit rows redact query strings and link a verifiable per-zone HMAC chain.
- **Area & owner.** `apps/api`, `apps/coordinator`, `packages/admin`, admin tokens, admin audit ledger - API/coordinator maintainers.

### T13 - Browser-tier session riding and BFF exposure

- **Problem.** The web BFF (`apps/auth`) turns a signed-in operator session into privileged admin-API calls, so a forged cross-site request (CSRF), a clickjacked action, a leaked/insecure session cookie, a brute-forced credential endpoint, or an unverified self-asserted identity could drive control-plane mutations or expand a foothold.
- **How Caracal handles it.**
  - _Same-origin by construction._ The production image serves the SPA from the BFF itself, so there is no cross-site cookie or open CORS surface, and Better Auth's state-changing routes are CSRF-protected against the trusted-origin allowlist.
  - _Explicit origin enforcement._ Every state-changing proxied or custom request is rejected unless its `Origin` (or `Referer` origin) matches the trusted allowlist, independent of cookie `SameSite`. The localhost dev origin is never seeded into the production allowlist.
  - _Hardened browser surface._ All responses carry `Content-Security-Policy` (with `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, and HSTS when HTTPS; session cookies are `HttpOnly`, explicitly `Secure`, and `SameSite`-pinned; sessions expire after a fixed seven days and never refresh on activity.
  - _Identity is verified before it is trusted._ Registration is restricted to allowlisted operators on every path; password sign-up is disabled in production by default; where re-enabled, a verified email (SMTP-delivered) is required before a session is issued; only provider-verified identities are trusted for automatic account linking.
  - _Least authority per account._ Reads are proxied with a derived read-capability token and writes with a derived write token, keeping the bootstrap admin token as break-glass. A signed per-request account assertion lets the API enforce, fail-closed, that each account reaches only zones it owns; operator identity is asserted in parallel for attribution, joined to the tamper-evident admin-audit row by request id.
  - _Abuse resistance and least exposure._ Credential endpoints are rate-limited with database-backed counters in production; the proxied path is re-validated after normalization, including percent-encoded traversal (`%2e`/`%2f`/`%5c`); internal error detail is logged server-side and never returned to the browser; only the web tier is intended for ingress. The BFF remains an internet-facing single point holding admin-level authority - tracked in [Known Limits and How Caracal Contains Them](#known-limits-and-how-caracal-contains-them).
- **How we verify.** `tests/typescript/unit/auth/` (`security`, `config`, `proxyCredential`, `zoneAccess`, `static`) - origin enforcement, header hardening, encoded-traversal rejection, allowlist and sign-up gating, derived-credential selection, and account-zone binding - plus API-side `auth` tests for assertion verification and ownership enforcement; manual image verification that the SPA is same-origin, cross-site writes return 403, and readiness gates on the session store.
- **Area & owner.** `apps/auth`, `apps/web` - Web/BFF maintainers.

### T14 - AI Operator misuse and prompt-driven escalation

- **Problem.** The Operator turns conversation and LLM output into control-plane changes, so prompt injection, a malicious or compromised model provider, or abuse of the Operator's reserved credentials could drive unauthorized mutations, expose operator-supplied secrets, or reach zones the Operator should not govern.
- **How Caracal handles it.**
  - _Model output only proposes._ Every mutation flows through a plan that requires explicit approval, and each execution re-validates step authority against the caller's capability set. Autopilot is off by default with a zero write budget; when enabled, its writes are budget-bounded.
  - _Structural least privilege._ The Operator runs as reserved `caracal.sys` applications with separate role identities (LLM, researcher, executor) whose STS traits structurally bound what each may mint. Credentials are generated in-process, auto-rotated, never persisted in plaintext, and fail closed past their `control:expires` deadline; control tokens are per-invoke and single-use (JTI replay).
  - _Zone reach is opt-in._ Cross-zone execution is honored only for the reserved operator subjects and only toward existing, non-archived, non-reserved, non-isolated zones that explicitly granted operator administration; the deployment's capability allowlist further narrows what the Operator may do.
  - _Secrets stay out of the model._ Operator-supplied credentials live in a server-side plan-secrets vault, are injected only at execution, and are never echoed into conversation turns or model context; one-time secret outputs are returned once and never persisted.
  - _Bounded model interaction._ Provider calls are capped per turn and by output tokens; provider configuration fails closed on a missing base URL or model; governed LLM data-plane access uses real platform mandates through delegation rather than ambient credentials.
- **How we verify.** `tests/typescript/unit/api/operator-*.test.ts` - authority denial at execution, autopilot budget enforcement, capability allowlisting, plan-secret vault isolation, role scope narrowing, zone opt-in refusal, and credential-rotation fail-closed behavior.
- **Area & owner.** `apps/api` operator routes and control identity, `apps/api/src/control` - API maintainers.

## Review Triggers

Review and update this threat model when any of the following occurs:

- Authorization, policy, token, key, revocation, replay, step-up, or scope logic changes.
- API, coordinator, auth/BFF, gateway, STS, audit, control, relay, transport, connector, or SDK boundaries change.
- Operator capability, autopilot, plan-governance, provider, or credential behavior changes.
- A new service, route, package, stream, database table, port, container, secret, provider integration, export target, or release artifact is introduced.
- Compose, Dockerfile, installer, image registry, mode, secret handling, or deployment defaults change.
- Dependency updates affect auth, crypto, HTTP, parsing, policy, database, Redis, build, installer, or release behavior.
- A security incident, near miss, audit finding, bug bounty report, or operational outage exposes an unmodeled risk.
- Enterprise isolation, licensing, or shared-interface assumptions change.
- Before each major release and after any high-risk dependency or platform update.

This threat model and the incident response process are best-effort open-source governance artifacts; Caracal is provided under the Apache License 2.0 without warranties or liability as stated in [`LICENSE`](../LICENSE). For contractual assurances, support, or enterprise terms, contact Caracal Enterprise at [contact@caracal.run](mailto:contact@caracal.run).
