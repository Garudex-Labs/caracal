# Incident Response

## Purpose

Give maintainers a fast, repeatable way to detect, contain, recover from, and learn from security or reliability incidents in Caracal.

One Incident Lead owns sequencing, decisions, evidence, and closure. One Driver makes changes. One Reviewer checks risk. On an IR team, one person may cover multiple roles, but ownership must be explicit.

## Scope

Use this process for incidents affecting:

- `apps/api`: control-plane routes, admin auth, zones, applications, resources, providers, policies, policy sets, grants, step-up challenges, admin tokens, audit retention, the AI Operator, and the optional control invocation plugin (`apps/api/src/control`).
- `apps/coordinator`: Session lifecycle, Delegation, invocation, TTL, retention, outbox, and lifecycle events.
- `apps/auth` and `apps/web`: operator sign-in, sessions, the authenticated console proxy, and the web console.
- `services/sts`: token exchange, OPA policy decisions, signing keys, JWKS, replay, revocation, step-up, and audit emission.
- `services/gateway`: proxy enforcement, upstream safety, STS exchange, bindings, replay, and revocation checks.
- `services/audit`: audit stream consumption, append-only ledger, HMAC chain, tamper sweeps, retention, and export.
- Redis Streams, PostgreSQL, Docker runtime, installers, releases, dependencies, and shared `packages/*`.

Use the public issue tracker for non-security bugs. Use a private GitHub Security Advisory for suspected vulnerabilities, credential exposure, unsafe execution, policy bypass, or exploitable operational failures.

## Severity Levels

| Level | Use when | First action |
|---|---|---|
| SEV0 | Active exploit, credential/signing-key exposure, policy bypass, unsafe execution, malicious release, or evidence destruction. | Contain immediately; restrict, revoke, rotate, disable, or stop the affected path. |
| SEV1 | Plausible exploit with high impact, auth boundary weakness, unsafe gateway/control behavior, audit integrity risk, or dependency compromise. | Add a guardrail or temporary restriction before root-cause work. |
| SEV2 | Reproducible security or reliability weakness with limited blast radius and no active exploit. | Reproduce, patch, and validate through targeted tests. |
| SEV3 | Hardening, suspicious signal, low-risk misconfiguration, or unconfirmed report. | Track, investigate, and close or promote with evidence. |

Escalate severity immediately if tokens, secrets, keys, policy enforcement, audit integrity, release artifacts, or runtime availability are affected.

## Detection and Intake

| Check | Action | Evidence | Move on when |
|---|---|---|---|
| Source of signal: advisory, email, issue, logs, CI, dependency alert, runtime health, audit metrics, or maintainer observation. | Create or update the private advisory for security incidents; assign an Incident Lead. | Reporter text, timestamps, URLs, affected refs, service names, versions, and initial severity. | There is one source of truth and an owner. |
| Affected boundary: API, coordinator, auth/BFF, web console, STS, gateway, audit, control, relay, package, infra, release, or dependency. | Map the signal to the threat model target area. | File paths, endpoints, stream names, containers, images, package names, and config keys. | The suspected blast radius is named. |
| Sensitive data risk. | Remove secrets from public channels; preserve private copies only in the advisory or approved secure storage. | Redacted samples plus location of original evidence. | No sensitive data is exposed in public discussion. |

## Triage

| Check | Action | Evidence | Move on when |
|---|---|---|---|
| Reproducibility. | Reproduce locally or in an isolated runtime using the smallest safe proof. Do not run destructive payloads against shared systems. | Exact request, command, token shape, config, commit, container version, and observed result. | The issue is confirmed, rejected, or needs more data. |
| Security impact. | Determine whether the issue affects auth, policy, keys, secrets, audit, stream integrity, upstream routing, command invocation, releases, or availability. | Impact statement and affected assets from the threat model. | Severity is assigned or revised. |
| Current exposure. | Check if the affected path is reachable in rc or stable mode, exposed by Compose ports, shipped in a release, or gated by a feature flag/profile. | Mode, image tag, package version, route, port, or profile status. | The Incident Lead knows whether immediate containment is needed. |

## Containment

| Check | Action | Evidence | Move on when |
|---|---|---|---|
| Unsafe execution or policy bypass. | Disable the route/profile/path, tighten scopes, deny the policy, revoke sessions, block the upstream, or stop the affected service. | Exact control changed, owner, time, and rollback path. | The exploit path no longer succeeds. |
| Secret, token, or key exposure. | Rotate affected secrets, admin tokens, client secrets, signing keys, Redis/PostgreSQL credentials, and stream/audit HMAC keys as applicable. Revoke active sessions and JTIs. | Key IDs, token/session scope, rotation confirmation, revocation event, and affected versions. | Exposed credentials no longer authenticate. |
| Malicious or vulnerable release/dependency. | Pull or supersede the artifact, pin or revert the dependency, publish a patched version, and warn users through the advisory path. | Artifact digest, package version, lockfile diff, image tag, and replacement version. | Users have a safe upgrade path or the artifact is no longer distributed. |
| Audit or stream integrity risk. | Preserve Redis pending entries, PostgreSQL rows, audit exports, DLQ records, service logs, and tamper metrics before cleanup. | Snapshot location, checksums where practical, and query/log summary. | Evidence is preserved and the risky path is restricted. |

Contain first for SEV0/SEV1. Root-cause work waits until the blast radius is bounded.

## Eradication

| Check | Action | Evidence | Move on when |
|---|---|---|---|
| Root cause. | Identify the exact missing guard, unsafe default, race, dependency flaw, release failure, or operational gap. | Minimal root-cause note with files, functions, routes, streams, config, or artifacts. | The fix target is precise. |
| Code/config fix. | Make the smallest complete change that removes the unsafe path. Prefer deny-by-default, explicit validation, scoped authorization, safe retries, and bounded timeouts. | Diff, tests added, config changed, migration or release notes if needed. | The vulnerable behavior is removed, not hidden. |
| Related paths. | Search for duplicate enforcement gaps across API, coordinator, auth/BFF, STS, gateway, audit, control, relay, packages, and infra. | Search terms, matching files, and decision for each match. | No known sibling path remains exposed. |

## Recovery

| Check | Action | Evidence | Move on when |
|---|---|---|---|
| Service safety. | Restore disabled routes, profiles, services, or upstreams only after the fix and containment controls are both verified. | Recovery command, config diff, release version, and readiness output. | Services are healthy without re-opening the incident path. |
| State consistency. | Reconcile PostgreSQL records, Redis streams, pending entries, revocations, sessions, audit rows, exports, and outbox state. | Queries, counts, DLQ/Pending Entry List status, tamper sweep result, and manual corrections. | Durable state matches expected behavior. |
| User/runtime impact. | Identify affected versions, operators, actions, tokens, policies, or audit records. | Impact window, affected artifacts, upgrade path, and known limitations. | Operators know what to update or rotate. |

Recovery must be rollback-safe: keep the last known safe version, containment toggle, or denial rule available until validation is complete.

## Communication

| Check | Action | Evidence | Move on when |
|---|---|---|---|
| Internal coordination. | Keep all facts, decisions, commands, and artifacts in the private advisory. Avoid parallel notes. | Advisory timeline and owner updates. | Maintainers share one current state. |
| Reporter updates. | Acknowledge, request missing reproduction details, confirm containment, confirm fix availability, and coordinate disclosure. | Message summaries and timestamps. | Reporter has enough information without exposing users. |
| Public disclosure. | Publish only after containment or fix is available. Include affected versions, impact, mitigation, fixed version, and credit if appropriate. | Advisory, release note, or security notice. | Users can act without receiving exploit instructions. |

For SEV0/SEV1, communicate checkpoints: acknowledged, contained, fix ready, release published, closed.

## Evidence and Audit Trail

Capture enough to prove what happened and what changed:

- Incident ID, severity, Incident Lead, Driver, Reviewer, and timestamps.
- Affected services, packages, routes, streams, ports, images, versions, commits, and config keys.
- Sanitized logs, metrics, audit events, DLQ/Pending Entry List data, tamper results, database query summaries, and reproduction steps.
- Containment actions, rotations, revocations, denials, disabled paths, and rollback handles.
- Patch diffs, test output, release artifacts, image digests, dependency diffs, and validation notes.

Do not paste secrets, private keys, bearer tokens, customer data, or exploitable payloads into public issues, logs, AI prompts, or release notes.

## Automation and AI-Assisted Workflows

Use automation to reduce time-to-context, not to replace maintainer judgment.

| Workflow | Use | Guardrail |
|---|---|---|
| Code search and dependency diffing | Find affected routes, auth hooks, policy checks, stream consumers, package versions, and release artifacts. | Review results manually before patching. |
| Test selection | Run targeted service tests first, then broader suites when the fix touches shared packages or boundaries. | Do not treat unrelated green tests as proof of security. |
| Log and audit summarization | Cluster timestamps, request IDs, JTIs, zone IDs, service names, tamper metrics, DLQ entries, and failure classes. | Redact secrets and keep sensitive data in approved private systems. |
| AI-assisted investigation | Ask local or approved AI tooling to summarize code paths, compare diffs, generate hypotheses, or draft validation checklists. | Never provide secrets, embargoed exploit details, private keys, bearer tokens, or customer data. Verify every conclusion against code and evidence. |
| AI-assisted validation | Generate negative test ideas for auth bypass, SSRF, replay, revocation, stream forgery, audit tamper, and unsafe control invocation. | Maintainers choose and run the final tests. |

Useful commands are the existing repository commands: targeted `go test ./services/<service>/...`, targeted `pnpm --dir <app-or-package> test`, `pnpm run test:go`, `pnpm run test:typescript`, `pnpm run test:python`, `pnpm run typecheck`, and `pnpm run ci`.

## Validation / Recovery Verification

| Check | Action | Evidence | Close when |
|---|---|---|---|
| Exploit regression. | Re-run the original reproduction and at least one negative variant. | Before/after result and test name or command. | The exploit fails for the right reason. |
| Boundary coverage. | Validate affected trust boundaries from `THREAT_MODEL.md`: auth, policy, gateway upstreams, streams, audit, secrets, runtime, release, or enterprise isolation. | Checklist tied to impacted threats. | Each affected boundary has a guard and a test/review note. |
| Targeted tests. | Run the smallest relevant suite first: API, coordinator, auth/BFF, STS, gateway, audit, control, relay, package, infra, installer, or release check. | Command output or CI link. | Relevant tests pass or failures are explained as unrelated. |
| Broader safety. | Run broader tests/typecheck/CI when shared packages, auth, crypto, config, release, or infra changed. | Command output or CI link. | No changed boundary remains unvalidated. |
| Runtime readiness. | Check `/health`, `/ready`, metrics, stream lag, audit tamper metrics, and dependency status in the affected stack. | Health/readiness output and metric summary. | Runtime behavior is stable under the recovered configuration. |

## Postmortem and Lessons Learned

| Check | Action | Evidence | Close when |
|---|---|---|---|
| What happened and what was affected. | Write a short factual timeline and impact summary. | Detection source, affected services/packages/artifacts, severity changes, and impact window. | The incident can be understood without reading raw logs. |
| What contained and fixed it. | Record containment, root cause, final fix, and validation. | Containment action, commit/PR, test output, release version, and recovery checks. | The fix path is traceable from report to recovery. |
| What must change. | Create follow-up issues only for concrete work with an owner. Update tests, automation, docs, threat model, release process, or architecture when needed. | Issue links, owner, target area, and security review notes. | Follow-ups are tracked or explicitly rejected with a reason. |

Close the incident when the fix is shipped, validation is recorded, communication is complete, and follow-ups are owned.

## Review Triggers

Review this process when:

- An incident, near miss, outage, or security report shows the runbook was unclear or too slow.
- Authorization, policy, token, key, revocation, replay, step-up, audit, stream, gateway, control, release, or dependency handling changes.
- New services, routes, streams, ports, packages, transports, providers, installers, images, secrets, or export targets are added.
- The threat model changes or identifies a new failure mode.
- Automation, AI tooling, logging, metrics, CI, release, or advisory workflows change.
- A fix requires security review, architectural change, or threat model update to prevent recurrence.

This incident response process is a best-effort open-source governance artifact; Caracal is provided under the Apache License 2.0 without warranties or liability as stated in [`LICENSE`](../LICENSE). For contractual assurances, support, or enterprise terms, contact Caracal Enterprise.
