<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Caracal Product and Engineering Roadmap

Caracal is being built for organizations that need to know what their developers' AI coding harnesses use, maintain approved AI Resources centrally, distribute consistent versions, investigate agent activity, and enforce access as those workflows become more capable.

The product model is **Organization -> Projects -> Users/Members -> Resources**. An Agent is a Resource that composes component Resources into a harness-ready configuration. Deployment-level Operator authority remains separate from Organization administration and tenant content ownership.

This roadmap begins with the current repository. It does not treat planned policy, credential, or runtime controls as shipped functionality. Phases are capability gates rather than release dates: work may overlap, but each exit condition defines what later phases can safely depend on.

## Current System

### Resource lifecycle

The registry currently presents Agents, MCP servers, Skills, Hooks, and Prompts through a unified Resource read model. A Resource has canonical `namespace/slug` identity, an owning Project, owner and co-author metadata, visibility, lifecycle activity, and version history.

Versions carry the distributable payload and move through `draft`, `pending`, `approved`, `rejected`, and `archived` states. The product presents proposed and decided Versions as Changes inside each Resource workspace. Reviews include scoped approval or rejection, version diffs, review issues, comments, and Inbox notifications. Public work is reviewed by deployment reviewers; project-scoped work is reviewed by Project leads; private work remains creator-only.

### Distribution and harness integration

Agent Versions compose component references, prompts and model settings, optional external MCP definitions, success criteria, and generated harness configurations. The CLI can author and publish Agents, scan installed components, pull Agents or individual components, record resolved versions in local lockfiles, and synchronize outdated installations.

A canonical harness registry defines capabilities, paths, scopes, config keys, hook events, guidance files, and session parser selection. Ten harness integrations are registered today. Support is capability-specific: a harness may support MCP configuration, Skills, Hooks, or Prompts without supporting every other function.

### Traces and usage intelligence

Managed hooks, plugins, extensions, and `caracal reconcile` deliver session records through a checkpointed ingest protocol and durable local outbox. ClickHouse stores session events and aggregates. Harness-specific parsers normalize those records into Traces with prompts, assistant events, tool calls and results, token data, lifecycle events, and cost data when the source provides it.

Project Intelligence combines registered Agents with session activity, installs, review issues, ownership, tool completion, cost visibility, and adoption signals. Agent insight reports use approved-version sessions and can apply suggestions to a draft for human review.

### Identity, tenancy, and security

Better Auth sessions mint short-lived tenant or Operator JWTs, verified with asymmetric keys. Revocation depends on Redis and fails closed. Organization roles (`owner`, `admin`, `member`) and Project roles (`lead`, `user`) resolve to server-side permissions on every request. Deployment roles (`operator`, `reviewer`, `user`) govern a separate operational surface.

Current controls include Resource visibility, scoped Reviews, tenant isolation, ownership checks, trace privacy, retention, audit logs, security events, diagnostics, and deployment settings. Caracal reads harness configuration and transcripts; it does not currently proxy MCP traffic, broker company credentials, or make live tool authorization decisions.

## Phase 1: Make the Resource Lifecycle Authoritative

**Why it matters.** Distribution, policy, evaluation, and rollback all need one stable answer to: what Resource is this, which Version is being proposed or used, and who approved the Change?

**Builds on.** The unified Resource index, per-family listings and Version tables, Agent composition, Resource activity, Changes views, Reviews, issues, ownership, and retention.

**Engineering outcome.** Define one lifecycle contract across every Resource family. A Change should bind a proposed Version, structured diff, author, review scope, issues, decisions, and resulting release state. Approved Versions must remain reproducible and dependency references must resolve to exact Versions rather than an ambiguous latest value. Provenance, source revision, content digest, compatibility, deprecation, and supersession metadata should travel with the Version.

New Resource families, such as managed CLIs, guidance files, or bundled configurations, should enter only after they can use the same identity, Version, Change, Review, visibility, provenance, and distribution contracts. Type-specific metadata remains in adapters instead of weakening the shared lifecycle.

**Exit gate.** Every distributable artifact can be traced from an immutable approved Version back through its Change, Review decisions, source, dependencies, and owners. A release can be reproduced or withdrawn without rewriting history.

## Phase 2: Make Distribution Verifiable Across Harnesses

**Why it matters.** Central management is not useful if developers still need separate manual installation and cleanup procedures for each harness, or if Caracal cannot prove which configuration is active.

**Builds on.** The harness registry, config generators, per-harness scanners, `pull`, `sync`, managed hook installation, lockfiles, and local layer snapshots.

**Engineering outcome.** Turn each harness integration into a tested conformance contract covering discovery, install planning, file generation, merge behavior, instrumentation, reconciliation, update, cleanup, and rollback. Installation plans should report which Agent requirements are supported, skipped, or blocking before writing files. Applied plans should record exact Resource Versions and content digests so server inventory, local lockfiles, and scanned configuration can be reconciled.

Add staged distribution controls for Projects, explicit update channels or pins, drift reporting, and reliable uninstall/rollback behavior. Expanding to additional harnesses should require capability declarations, adapter tests, parser fixtures where telemetry exists, and user-visible limitations rather than shared-code exceptions.

**Exit gate.** An administrator can select an approved Agent Version, preview its effect for a target Project and harness, distribute it through native configuration, verify the installed state, detect drift, and roll it back without maintaining a parallel manual configuration system.

## Phase 3: Turn Traces Into Reliable Evidence

**Why it matters.** Policy and evaluation cannot rely on telemetry that hides attribution gaps or makes unlike harness events look equivalent.

**Builds on.** Checkpointed ingest, the durable outbox, Project-scoped session storage, normalized Trace parsers, live updates, layer snapshots, current dashboards, alerts, and retention.

**Engineering outcome.** Define a cross-harness event contract with explicit coverage and missing-data semantics. Strengthen attribution from a session to User, Project, Harness, Agent, Agent Version, component Version, and local configuration snapshot. Normalize tool and MCP identity, results, errors, timing, token use, and cost only where the source can support those facts.

Move privacy controls closer to the data model: configurable redaction, content classification, retention, export, and access decisions should apply consistently to ingest, stored events, live subscriptions, reports, and support bundles. Add data-quality and instrumentation health signals so missing events are distinguishable from zero activity.

**Exit gate.** Every usage, security, or evaluation claim can cite its source Traces, attribution, time window, and coverage limitations. Organizations can retain useful operational evidence without granting broad access to session content.

## Phase 4: Extend Identity Into Workforce Permissions

**Why it matters.** Organization-wide policy needs stable subjects. A deployment role or Project membership alone cannot express company teams, job functions, employee exceptions, automation identities, or delegated administration.

**Builds on.** Better Auth, SSO, short-lived auth contexts, the User directory, Organization and Project memberships, current permission sets, invitation flows, departments, and audit events.

**Engineering outcome.** Introduce Organization-scoped Teams or groups as policy subjects, not as another tenancy layer. Map authoritative IdP groups and employee attributes into those subjects with observable synchronization and revocation. Model human Users, service accounts, and workload identities explicitly.

Expand permissions from broad Resource read/write administration into actions such as discover, install, update, publish, approve, execute, read Trace content, view cost, and request credentials. Preserve server-side membership resolution so stale JWT claims cannot retain authority. Add delegated administration, time-bound exceptions, break-glass access, and reviewable access changes.

**Exit gate.** Every protected action resolves to an authenticated principal, Organization, Project, workforce attributes, effective permissions, and an auditable reason. Removing a user or group assignment predictably removes the associated access.

## Phase 5: Establish Policy and Governance Decisions

**Why it matters.** Reviews and visibility govern registry publication today, but they do not express what a particular User, Team, Agent, or Harness may install or execute.

**Builds on.** The authoritative Resource lifecycle, verifiable distribution, Trace evidence, workforce subjects, existing permissions, Reviews, audit logs, security events, and settings.

**Engineering outcome.** Add versioned policy objects with inheritance across Organization, Project, Team, role, and User scopes. Policies should target Harnesses, Agents, Resources, MCP servers, individual tools, and service connections, and decide concrete actions such as discovery, installation, update, execution, Trace access, or credential use.

Build one explainable decision service used by the API, CLI, web UI, config generation, and synchronization. Define deterministic precedence for inherited rules and exceptions. Add simulation, impact previews, staged activation, and decision logs. Connect approval requirements to policy and evidence, including provenance, new tool exposure, network access, secret requirements, risk classification, and requested audience.

The first enforcement points should be operations Caracal already owns: registry visibility, publication, Review routing, config generation, pull, and sync. Runtime enforcement remains a later capability.

**Exit gate.** The same request produces the same explained policy decision across UI, CLI, and API. Every allowed or denied managed operation records the policy Version, subject, target, context, and decision.

## Phase 6: Enforce Runtime Access and Issue Scoped Credentials

**Why it matters.** Installation policy cannot protect company systems after a harness starts running. Long-lived credentials copied into local config also exceed the identity and lifetime of the Agent action that needs them.

**Builds on.** Policy decisions, exact installed-state evidence, short-lived identity, harness Hooks, MCP metadata, service ownership, audit events, and revocation.

**Engineering outcome.** Model company services and infrastructure connections as governed Resources. Add a credential broker that issues short-lived credentials scoped to the principal, Project, Harness, Agent, tool, service, and approved action. Registry content and Traces must contain references and redacted metadata, never credential values.

For harnesses with trustworthy pre-tool, MCP, or execution interception points, call the policy service before access and fail according to the Organization's configured availability policy. Carry the decision and credential scope into audit and security events. Strengthen local execution runtimes with enforceable network, mount, resource, secret, and egress policies. Add immediate response actions for disabling a Version, revoking credentials, blocking a tool, and removing managed configuration.

Harnesses without an adequate enforcement point must be labeled detect-only or distribution-only. Caracal should not claim equivalent runtime protection where the integration cannot provide it.

**Exit gate.** Supported integrations demonstrate an end-to-end decision before a protected action, least-privilege credential issuance, complete audit evidence, and effective revocation. Unsupported paths are visible as capability gaps rather than silent bypasses.

## Phase 7: Evaluate and Improve Resources From Real Use

**Why it matters.** Organizations need evidence that an approved component works, remains safe, and is worth maintaining, not just counts of installs or sessions.

**Builds on.** Resource Versions and Changes, reliable Trace attribution, success criteria, Reviews and issues, policy decisions, install records, developer feedback, and current Project Intelligence.

**Engineering outcome.** Define evaluation suites and outcome measures per Resource Version. Combine reproducible tests with production signals such as task completion proxies, tool failures, cost, latency, policy violations, user feedback, adoption, and review findings. Compare candidate Versions with the approved baseline using explicit sample sizes, coverage, and confidence rather than opaque scores.

Expand Intelligence from current Project and Agent signals into Organization-level adoption, ownership, maintenance, security, and governance views while preserving tenant and cost authorization. Recommendations should prefer approved alternatives and explain the evidence behind them. AI-generated insights may propose a Change, but must not silently modify or promote an approved Version.

**Exit gate.** A maintainer or reviewer can decide whether to approve, promote, pause, or roll back a Version using attributable evaluation results and security evidence. Suggested improvements enter the normal Change and Review lifecycle.

## Phase 8: Enable Controlled Autonomy

**Why it matters.** More autonomous development is valuable only when an Organization can bound authority, observe behavior, stop execution, and recover from a bad decision.

**Builds on.** Governed Resources, verifiable distribution, workforce identity, policy decisions, runtime enforcement, scoped credentials, reliable Traces, and versioned evaluation.

**Engineering outcome.** Model repeatable workflows that compose Agents, component Resources, service access, evaluation checks, and approval gates. Allow Agents to request tools or credentials through policy rather than receiving standing access. Autonomous maintenance should create evidence-backed Changes with expected impact, required reviewers, rollout scope, and rollback plans.

Introduce progressive rollout only for policy-approved, low-risk Changes. Monitor live evidence against declared success and safety criteria; pause or revert automatically when thresholds are crossed. Human approval remains mandatory wherever policy, impact, evidence quality, or integration capability requires it.

**Exit gate.** An autonomous workflow cannot exceed its granted scope, bypass Review, hide its actions, retain credentials beyond their lifetime, or prevent an Operator or tenant administrator from stopping and reversing it.

## Cross-Cutting Requirements

Every phase must preserve these constraints:

- **Tenant isolation:** Organization and Project access is resolved server-side; Operator status does not imply ownership of tenant content.
- **Capability honesty:** distribution, telemetry, and enforcement claims remain specific to each harness integration.
- **Explainability:** Reviews, policy decisions, evaluations, and automated Changes retain their evidence and responsible principal.
- **Secret safety:** credentials are neither registry payloads nor telemetry content.
- **Reversibility:** Versions, policies, distribution changes, and automated actions have bounded rollout and rollback paths.
- **Human authority:** autonomy operates inside explicit policy and approval boundaries rather than replacing them.
