# Threat Model

## Purpose

This model identifies what can go wrong, who owns the response, what mitigation is expected, and how maintainers verify the system remains safe.

## Assurance Case

**Claim:** Caracal's security requirements — pre-execution authority, deny-by-default authorization, tamper-evident audit, secret confidentiality, and a trusted release path — are met for the in-scope open-source product.

The argument rests on four pillars, each substantiated by the sections and code referenced below.

1. **Threat model.** The threats are enumerated as T1–T12 in [What Can Go Wrong, and How Caracal Handles It](#what-can-go-wrong-and-how-caracal-handles-it). Each entry pairs the problem an adversary would exploit with the controls Caracal enforces against it, how maintainers verify those controls, and who owns them. [Review Triggers](#review-triggers) keeps the model current as boundaries change.

2. **Trust boundaries.** Boundaries are identified explicitly in [Trust Boundaries](#trust-boundaries): client→API/coordinator, API/coordinator→PostgreSQL/Redis, STS→keys/policy/sessions, gateway→upstreams, control→API/coordinator, producers→stream consumers, audit producers→audit service, containers→host, and OSS→enterprise. Every boundary states what is untrusted and where mediation occurs.

3. **Secure design principles are applied.** The design embodies the standard principles, and each is enforced in code:
   - *Deny-by-default / fail-safe defaults:* STS rejects partial policy results and fails closed on policy, key, replay, revocation, and signing errors; control is disabled unless `CARACAL_CONTROL_ENABLED=true`; the audit HMAC key is required in `rc`/`stable` (T2, T6, T9).
   - *Complete mediation:* the gateway performs a fresh STS exchange per proxied request and validates bindings before dispatch; protected routes require mandatory auth hooks (T1, T3).
   - *Least privilege:* STS issues narrowly scoped ES256 mandates; control enforces per-resource `control:<command>:<verb>` scopes; zone-scoped admin tokens limit blast radius (T2, T9, T12).
   - *Defense in depth:* application-layer zone guards are backed by row-level security, request size/timeout limits, SSRF egress blocking, and hardened containers (T1, T3, T8, T12).
   - *Separation of privilege and economy of mechanism:* OPA/Rego is the sole policy engine, the gateway is the only proxied-access path, and STS-issued tokens are the only accepted runtime authority ([Assumptions](#assumptions)).

4. **Common implementation weaknesses are countered.** The mitigations map to the recognized weakness classes, and each countermeasure is tested:
   - *Injection / malformed input:* schema validation (zod, OPA input contracts) on every untrusted request before database or Redis access (T1; route, property, and fuzz tests).
   - *Broken authentication / token confusion:* ES256 verification pins `WithValidMethods`, with issuer, audience, expiry, replay (JTI), and revocation checks (T2; STS negative tests).
   - *SSRF and unsafe egress:* the gateway resolves and blocks always-dangerous ranges — link-local/cloud-metadata, multicast, unspecified, and their NAT64-embedded forms — on both the pre-flight check and the connection-time dial. Loopback, RFC1918 private, unique-local, and CGNAT addresses are deliberately permitted because upstreams are operator-provisioned through the Control API, never client-supplied (T3; gateway SSRF tests). Every gateway HTTP client — the proxy, the STS exchange client, and the JWKS fetcher — refuses to follow redirects (`CheckRedirect` → `http.ErrUseLastResponse`), so a 3xx can never send injected credentials, the inbound bearer, or a JWKS fetch to a host that skipped the SSRF guard, egress allowlist, and credential-host checks (T3; gateway redirect tests).
   - *Sensitive data exposure:* secrets resolve from files, logs and responses redact key material and credentials, and the audit ledger never stores plaintext claims (T5, T6; redaction and audit tests).
   - *Tampering / integrity loss:* append-only audit writes with an HMAC chain, HMAC-signed Redis stream messages, and dedupe with ack-after-durable-handling (T6, T7; audit and stream tests).
   - *Supply-chain compromise:* reviewed lockfiles and module sums, CodeQL/Trivy/Scorecard scanning, and signed, provenance-attested release artifacts verifiable per [Verify a Release](https://caracal.run/security/verify-releases/) (T10; release checks).

Residual, knowingly-open items are tracked in [Known Limits and How Caracal Contains Them](#known-limits-and-how-caracal-contains-them) so the assurance case stays honest about its current limits and the containment already in place.

## Scope

In scope:

- `apps/api`: Fastify control plane for zones, applications, resources, providers, policies, grants, invitations, teams, step-up challenges, and admin audit.
- `apps/coordinator`: Fastify agent lifecycle, delegation, invocation, TTL, retention, and outbox service.
- `services/sts`: OAuth 2.0 token exchange, ES256 signing, JWKS, policy evaluation, step-up, replay, revocation, and audit emission.
- `services/gateway`: reverse proxy that exchanges inbound credentials with STS, validates bindings, enforces replay/revocation checks, and forwards authorized requests.
- `services/audit`: Redis Streams consumer, append-only PostgreSQL audit ledger, tamper checks, retention, and Parquet export.
- `apps/api/src/control`: optional in-process control invocation plugin gated by explicit enablement, ES256 bearer auth, per-resource scope checks against the engine catalog, JTI replay, rate limits, and audit.
- `apps/coordinator`: Redis Streams lifecycle relay job with signature verification and dedupe.
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
| Browser and the web backend-for-frontend (BFF) | The browser holds only a session cookie; the BFF (`apps/auth`) holds the admin/coordinator tokens server-side and serves the SPA same-origin. Treat all browser input as untrusted; enforce the request `Origin` on every state-changing proxied or custom call, set hardened security headers and `Secure`/`SameSite` cookies, rate-limit credential endpoints, and never expose the admin token or internal error detail to the browser. The BFF authenticates and gates operators — only allowlisted identities (`CARACAL_OPERATOR_EMAILS`, deny-by-default in production) may register — but does not yet issue per-operator authority: a signed-in session is proxied with the shared global admin token, with actions attributed to the operator by a server-side audit join (see [Known Limits and How Caracal Contains Them](#known-limits-and-how-caracal-contains-them)). |
| Web BFF to API/coordinator | The BFF translates a signed-in session into privileged admin-API calls; it must validate the normalized proxied path stays within the intended surface, propagate request/trace correlation, and cancel upstream work when the client disconnects. |
| Admin and automation clients to API/coordinator | Treat all request input, headers, tokens, and trace data as untrusted; validate with schemas and authorization before mutation. |
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

### Known Limits and How Caracal Contains Them

These are the consciously-accepted limits of the open-source product. Each names the limit honestly, the containment Caracal already enforces so the limit cannot become a single point of failure, and the path to closing it fully.

- **Row-level security is enabled and fail-closed, but not yet `FORCE`d.**
  - *The limit.* Services connect as the table owner, which bypasses `ENABLE`-only RLS, so database-level zone isolation is not yet self-enforcing.
  - *How Caracal contains it.* Application-layer zone guards mediate every mutation (T1), and each request already binds a per-request Postgres `caracal.zone_id`, so RLS is a forward-compatible backstop that activates the moment `FORCE ROW LEVEL SECURITY` or non-owner service roles are adopted — without an application rewrite.
  - *Path to closure.* Set the `caracal.zone_id` GUC in every service that touches zone tables, then enable `FORCE ROW LEVEL SECURITY` (or move services to non-owner roles).

- **The global bootstrap admin token can administer every zone.**
  - *The limit.* A single shared credential carries cross-zone authority.
  - *How Caracal contains it.* Zone-scoped, per-operator tokens are mintable through the global-only `POST /v1/admin-tokens` route (with `GET`/`DELETE` for listing and revocation), so routine administration uses one token per zone and the day-to-day blast radius is a single zone per credential. Minting is API-only and never exposed on the remote control/engine surface, keeping the privilege-issuance surface narrow.
  - *Path to closure.* Reserve the global bootstrap token for break-glass and operate exclusively with zone-scoped tokens.

- **`GATEWAY_STS_HMAC_KEY` is shared process-wide rather than per-zone.**
  - *The limit.* Compromise of this key affects gateway↔STS binding integrity across all zones, not just one.
  - *How Caracal contains it.* The key is delivered as a secret file, never logged or returned, and protects only the gateway↔STS binding channel; runtime authority itself remains independently ES256-signed and verified, so this key is not a standalone authority. It is required in rc/stable.
  - *Path to closure.* Derive per-zone binding keys so a single key compromise is contained to one zone.

- **Admin-audit completeness is best-effort, not atomic with the mutation.**
  - *The limit.* The generic per-mutation record is written in an `onResponse` hook on a separate transaction after the response is sent, with insert failures logged but not surfaced, so a mutation can commit while its audit row is absent if the audit write fails or the service crashes after responding.
  - *How Caracal contains it.* For recorded rows the per-zone HMAC chain is tamper-evident, so existing evidence cannot be silently altered or reordered; specific cascading semantic events (e.g., DCR shutdown) are already written inside the mutation's transaction; and audit-write failures are logged for reconciliation.
  - *Path to closure.* Emit the generic audit record inside the mutation's transaction or via the existing transactional outbox so audit durability is atomic with the change it records.

- **The web BFF is an internet-facing single point that holds god-tier credentials.**
  - *The limit.* `apps/auth` is the only intended ingress, binds `0.0.0.0` in production, and holds the global admin and coordinator tokens server-side. It authenticates and gates operators but does not yet issue per-operator authority: every signed-in session is proxied with the same shared global admin token. So a compromise of the auth process itself — a dependency vulnerability, an SSRF to its own loopback, or a logic flaw that bypasses the session gate — yields full cross-zone control-plane authority, and a single compromised operator session does the same.
  - *How Caracal contains it.* Registration is an authority boundary: `databaseHooks.user.create.before` rejects any identity outside `CARACAL_OPERATOR_EMAILS` on both email/password and social sign-up, and with no allowlist registration is open only in development and fails closed in production. Email/password sign-up — which would grant admin on a self-asserted, unverified email — is disabled in production by default, so operators bootstrap through a provider-verified identity (Google/GitHub) on the allowlist; where password sign-up is explicitly re-enabled in production, a verified email is required before a session is issued, and only provider-verified identities are trusted for automatic account linking. Before any proxy call the request is session-gated, origin-enforced (proxy and custom routes), header-hardened, and rate-limited on credential endpoints; the tokens are never exposed to the browser; and the proxy path is re-validated against literal and percent-encoded traversal. Every state-changing proxied action is logged server-side from the validated session and joined to the tamper-evident admin-audit row by request id, so actions attribute to the operator even though the proxy uses the shared token.
  - *Path to closure.* Mint a zone-scoped per-operator admin token through `POST /v1/admin-tokens` for each operator instead of reusing the shared global token, so the control plane enforces per-operator authority directly; keep the auth tier behind network controls so a process compromise is not internet-reachable.

- **Operator identity is only as strong as the configured sign-in path, and abuse limits are per-replica.**
  - *The limit.* A domain-suffix allowlist (`@example.com`) grants admin to any allowlisted-domain identity the configured identity provider will authenticate, so it is only as trustworthy as that provider and the operator's control over the domain. If an operator re-enables password sign-up without wiring an email-verification transport, `requireEmailVerification` blocks sign-in rather than verifying ownership — a usability failure that tempts disabling verification. Separately, Better Auth's rate-limit and the BFF's session-validation cache are in-process, so under horizontal scaling the credential brute-force ceiling and revocation-propagation window scale with replica count rather than being global.
  - *How Caracal contains it.* Social providers assert provider-verified emails, so an exact-email or domain allowlist over Google/GitHub binds admin to identities the provider vouches for; password sign-up is off by default in production precisely because its emails are unverified. Credential endpoints carry tight per-route limits even per-replica, the session cache TTL is a few seconds so revocation still takes effect quickly, and the upstream control plane independently verifies the admin token on every call.
  - *Path to closure.* Prefer exact-email allowlists or provider org/domain restrictions over broad domain suffixes; back Better Auth rate-limiting and session state with shared storage (e.g., the existing Redis) so abuse limits and revocation are global across replicas.

## What Can Go Wrong, and How Caracal Handles It

Each threat (T1–T12) states the **problem** an adversary would exploit, **how Caracal handles it** in code and architecture, **how we verify** the control holds, and the **area and owner** accountable. The intent is to stay honest about the risk while making the enforced defense explicit.

### T1 — Control-plane request bypass

- **Problem.** A request tries to bypass auth, zone ownership, scope checks, or input schemas to mutate control-plane state.
- **How Caracal handles it.** Auth plugins/hooks are mandatory on every protected route; each request is schema-validated before any database or Redis access; and zone, application, team, and scope guards are enforced at the mutation point.
- **How we verify.** API/coordinator route, security, property, fuzz, and contract tests; every new route is reviewed for auth hooks, schema validation, zone guards, and admin-audit coverage.
- **Area & owner.** `apps/api`, `apps/coordinator` — API/coordinator maintainers.

### T2 — STS over-issuance / fail-open

- **Problem.** STS could issue a token with excessive authority if policy, grant, session, step-up, replay, or key validation fails open.
- **How Caracal handles it.** STS is deny-by-default: it rejects partial policy results, verifies stored ownership/session state, requires step-up where configured, and fails closed on policy, key, replay, revocation, and signing errors.
- **How we verify.** `go test ./services/sts/...` with negative tests for policy denial, partial evaluation, bad keys, revoked sessions, replayed JTIs, expired step-up, and malformed JWT claims.
- **Area & owner.** `services/sts`, policy/grant storage — STS maintainers.

### T3 — Gateway egress / SSRF and authority reuse

- **Problem.** The gateway could forward a request to an unsafe or unintended upstream, leak routing headers, reuse authority, disclose upstream-internal targets, or miss replay/revocation state.
- **How Caracal handles it.** It performs a fresh STS exchange per proxied request; strips hop-by-hop and `X-Caracal-*` headers; enforces request size and timeouts; and blocks always-dangerous upstream ranges — link-local/cloud-metadata, multicast, unspecified, and their NAT64-embedded forms — on both the pre-flight guard check and the connection-time dial (closing the DNS-rebinding TOCTOU window). Loopback, RFC1918 private, unique-local, and CGNAT addresses are permitted by design because upstream URLs are operator-provisioned through the Control API and never client-supplied; the client only selects among already-bound resources. An optional egress allowlist pins the initial upstream host. Every gateway HTTP client (proxy, STS exchange, JWKS fetch) sets `CheckRedirect` to `http.ErrUseLastResponse`, so a redirect is never followed: the upstream 3xx is surfaced to the caller unfollowed and no injected credential, inbound bearer, or JWKS request reaches an unvetted host. On response fan-out the gateway also treats the untrusted upstream defensively — stripping `Server`/framework banners, the `X-Caracal-Identity` mirror, and any absolute or protocol-relative `Location`/`Content-Location`/`Refresh` redirect target (relative references are preserved) — so an upstream cannot disclose its internal topology or steer an agent client off the gateway's enforced path.
- **How we verify.** `go test ./services/gateway/...` covering SSRF metadata/link-local/multicast/unspecified/NAT64-embedded blocking, the private/loopback/CGNAT allow-by-default policy, egress-allowlist enforcement, redirect non-following (the 3xx is surfaced and the redirect target is never dialed or credentialed), response-side banner and redirect-target sanitization, header stripping, request-size, timeout, replay, revocation, and STS-failure cases.
- **Area & owner.** `services/gateway`, resource bindings — Gateway maintainers.

### T4 — Lifecycle / delegation state inconsistency

- **Problem.** Agent lifecycle or delegation state could become inconsistent through races, missing transactions, outbox gaps, or relay replay.
- **How Caracal handles it.** Graph mutations use transactions and advisory locks; lifecycle, delegation, and invalidation events are published through the outbox; and relay dedupe and idle-claim behavior is bounded.
- **How we verify.** Coordinator and relay tests confirm graph mutations use transactions/locks and that lifecycle events flow through the outbox or relay-safe paths.
- **Area & owner.** `apps/coordinator`, Redis Streams — Coordinator maintainers.

### T5 — Secret / sensitive-claim exposure

- **Problem.** Secrets or sensitive claims could appear in logs, API responses, audit payloads, metrics, config, fixtures, release artifacts, or examples.
- **How Caracal handles it.** Secrets resolve from secret files; known sensitive log paths are redacted; and responses never return plaintext key material, client secrets, bearer tokens, subject claims, database URLs, or Redis URLs.
- **How we verify.** Review of logs, metrics, API responses, audit events, fixtures, and generated artifacts for secrets, confirming redaction covers any new credential fields.
- **Area & owner.** All services, apps, packages, infra — owning component maintainer.

### T6 — Audit integrity / ordering loss

- **Problem.** Audit evidence could be missing, forgeable, mutable, unverifiable, or lose ordering during dependency failures.
- **How Caracal handles it.** `audit_events` is append-only; chain entries are HMAC-signed when configured; streams are acknowledged only after insert, duplicate handling, or DLQ routing; and tamper sweeps plus retention/export jobs run under leader locks.
- **How we verify.** `go test ./services/audit/...` for append-only writes, HMAC chain checks, tamper-mismatch metrics, DLQ paths, retention rotation, and export behavior.
- **Area & owner.** `services/audit`, audit producers, Redis Streams, PostgreSQL — Audit and producer maintainers.

### T7 — Stream forgery / replay / double-processing

- **Problem.** Redis Streams messages could be forged, replayed, dropped, processed twice, or acknowledged before durable handling.
- **How Caracal handles it.** Stream HMAC keys are required in rc and stable; producer signatures are verified where configured; messages are deduped; and transient failures stay in the pending-entry list for reclaim.
- **How we verify.** Stream consumer tests for valid signature, missing signature in runtime, duplicate message, transient dependency failure, PEL reclaim, and DLQ routing.
- **Area & owner.** STS, API, coordinator, audit, relay, gateway revocation consumers — Stream producer/consumer maintainers.

### T8 — Availability degradation disabling enforcement

- **Problem.** Runtime availability could degrade enough to disable enforcement, token exchange, audit, revocation, or control invocation.
- **How Caracal handles it.** Bounded request bodies, timeouts, rate limits, health/readiness checks, resource limits, restart policies, and localhost-only port bindings are preserved; readiness fails when PostgreSQL, Redis, STS, or required upstreams are unavailable, so enforcement never silently returns success-shaped responses.
- **How we verify.** Service readiness checks in the Compose stack confirm dependency outages return unavailable status rather than success-shaped responses.
- **Area & owner.** Compose stack, PostgreSQL, Redis, STS, gateway, audit, control — Infra and service maintainers.

### T9 — Control invocation as a privilege-escalation path

- **Problem.** Optional control invocation could become a command-execution path outside `engine.dispatch`, run without audit, or use remote scopes that expand zone-bound tokens into global admin authority.
- **How Caracal handles it.** Control is disabled unless `CARACAL_CONTROL_ENABLED=true` and the runtime gate file is present; only `POST /v1/control/invoke` is allowed; each call requires the per-resource `control:<command>:<verb>` scope derived from the engine catalog; commands are validated through `engine.dispatch` and never shelled out; zone binding is enforced before any admin call that affects zone-scoped state; zone CRUD and other global operations require an explicit global-control model; and both accepted and rejected requests are audited.
- **How we verify.** `pnpm --dir apps/api test` and `pnpm --dir packages/engine test` for disabled startup, missing scope, hidden-command refusal, invalid flags, replay, rate limit, upstream failure, audit emission, zone-bound dispatch, and explicit denial or separate governance of global zone operations.
- **Area & owner.** `apps/api/src/control`, `packages/engine`, `packages/admin` — Control maintainers.

### T10 — Supply-chain / release compromise

- **Problem.** A compromised dependency, generated artifact, installer, image, or release process could ship malicious or vulnerable code.
- **How Caracal handles it.** Lockfiles and module sums are reviewed; images and archives are published only from trusted release paths; installers, Dockerfiles, and generated artifacts are checked for embedded secrets and uncontrolled network fetches; and CodeQL, Trivy, and Scorecard scanning plus signed, provenance-attested artifacts make releases independently verifiable per [Verify a Release](https://caracal.run/security/verify-releases/).
- **How we verify.** Dependency review, lockfile diff review, release smoke tests, image build checks, and installer/archive secret scans before publishing.
- **Area & owner.** `package.json`, `pnpm-lock.yaml`, Go modules, Dockerfiles, installers, releases — Release maintainers.

### T11 — Boundary drift as the system grows

- **Problem.** Security boundaries could drift when new services, ports, packages, transports, provider integrations, or enterprise references are added.
- **How Caracal handles it.** This model, service instructions, tests, and governance are updated whenever boundaries change, and OSS changes that depend on enterprise-only code or undocumented controls are rejected.
- **How we verify.** During review, changed files are compared against this model, `go.work`, workspace packages, service instructions, and Compose boundaries.
- **Area & owner.** Repo architecture and governance — Maintainers approving the change.

### T12 — Admin-foothold expansion and audit evasion

- **Problem.** A compromised or shared admin credential, a spoofed internal header, an unauthenticated metrics/docs surface, or a forgeable admin-audit record could expand a single control-plane foothold into broad multi-zone compromise — or hide the act.
- **How Caracal handles it.**
  - *Intent comes from identity, not headers.* Control-resource and internal-trait intent is derived from the authenticated actor scope (`actor.scope === 'global'`), never from caller-supplied `X-Caracal-*` headers; the step-up approver is bound to the authenticated actor, never to a request-body field.
  - *Operational surfaces are closed by default.* The network-bound `/metrics` requires a metrics bearer (or refuses) in rc/stable, and OpenAPI/docs default off in published builds.
  - *Audit is tamper-evident.* Admin-audit rows redact OAuth `code`/`state` and all query strings, and are chained per zone with a tamper-evident HMAC chain (advisory-locked head read and insert kept atomic). Audit completeness is best-effort rather than transactional (see [Known Limits and How Caracal Contains Them](#known-limits-and-how-caracal-contains-them)).
  - *Blast radius is contained.* Distinct zone-scoped, per-operator admin tokens are mintable through the global-only `POST /v1/admin-tokens` route, reserving the shared global bootstrap token for break-glass; and each zone-scoped request binds Postgres `caracal.zone_id` so RLS becomes an enforced backstop the moment `FORCE ROW LEVEL SECURITY` (or non-owner roles) is enabled.
- **How we verify.** `tests/typescript/unit/api/routes/{applications,resources,step-up-challenges,admin-tokens}.test.ts`, `api/app.test.ts`, `api/config.test.ts`, `api/admin-audit.test.ts`, and `api/zone-scope.test.ts`; confirm header spoofing cannot alter control-resource/trait visibility, the step-up approver is the actor, `/metrics` denies unauthenticated access in published mode, docs default off when published, admin-token minting is global-only, and admin-audit rows redact query strings and link a verifiable per-zone HMAC chain.
- **Area & owner.** `apps/api`, `apps/coordinator`, `packages/admin`, admin tokens, admin audit ledger — API/coordinator maintainers.

### T13 — Browser-tier session riding and BFF exposure

- **Problem.** The web BFF (`apps/auth`) turns a signed-in operator session into privileged admin-API calls using a server-side global admin token, so a forged cross-site request (CSRF), a clickjacked action, a leaked/insecure session cookie, a brute-forced credential endpoint, or an unverified self-asserted identity could drive control-plane mutations or expand a foothold.
- **How Caracal handles it.**
  - *Same-origin by construction.* The production image serves the SPA from the BFF itself, so the browser makes no cross-origin calls; there is no cross-site cookie or open CORS surface to abuse, and Better Auth's own state-changing routes are CSRF-protected against the same trusted-origin allowlist.
  - *Explicit origin enforcement.* Every state-changing proxied or custom request (`POST/PATCH/PUT/DELETE`, including account deletion) is rejected unless its `Origin` (or `Referer` origin) matches the trusted allowlist, independent of cookie `SameSite`, so CORS-permitted reads can never become forged writes. The localhost dev origin is not seeded into the production allowlist.
  - *Hardened browser surface.* All responses carry `Content-Security-Policy` (with `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, and HSTS when HTTPS; session cookies are `HttpOnly`, `Secure` (explicit, not inferred), and `SameSite`-pinned.
  - *Identity is verified before it is trusted.* Registration is restricted to allowlisted operators (`CARACAL_OPERATOR_EMAILS`, deny-by-default in production) on every path. Email/password sign-up grants admin on a self-asserted, unverified email, so it is disabled in production by default — operators bootstrap through a provider-verified identity; where it is explicitly re-enabled, a verified email is required before a session is issued, and only provider-verified identities are trusted for automatic account linking.
  - *Abuse resistance and least exposure.* Credential endpoints are rate-limited; the proxied path is re-validated after normalization — including percent-encoded traversal (`%2e`/`%2f`/`%5c`) — so it cannot escape the intended `/v1` (or coordinator) surface; internal error detail is logged server-side and never returned to the browser; only the web tier is intended for ingress, with the API and coordinator internal.
  - *Attribution is bound to identity.* Every state-changing proxied action is logged server-side from the validated session and joined to the tamper-evident admin-audit row by request id, so an operator's actions cannot be attributed to anyone else. The BFF still proxies with the shared global admin token rather than zone-scoped per-operator tokens, the auth process is an internet-facing single point holding god-tier credentials, and per-replica in-memory rate-limit/session state weakens abuse limits at scale; these residuals are tracked in [Known Limits and How Caracal Contains Them](#known-limits-and-how-caracal-contains-them).
- **How we verify.** `tests/typescript/unit/auth/security.test.ts` (origin enforcement, header hardening, path-normalization including encoded traversal, request correlation) and `tests/typescript/unit/auth/config.test.ts` (operator allowlist, password-signup gating, production origin defaults), plus the BFF static-serving tests; manual image verification that the SPA is same-origin, security headers are present, cross-site writes return 403, password sign-up is off in production, and readiness gates on the session store.
- **Area & owner.** `apps/auth`, `apps/web` — Web/BFF maintainers.

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
