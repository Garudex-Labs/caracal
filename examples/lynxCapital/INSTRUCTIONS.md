# Lynx Capital Demo - Build Instructions

This file is the single source of truth for how the
`examples/lynxCapital` demo is built. It must be read and followed
before writing or modifying any code in this directory. These rules
override personal preferences.

The demo simulates a real internal system at a fictional firm called
**Lynx Capital**, an autonomous financial execution layer for global
companies. It must look and behave like a production application, not
a tutorial.

The detailed three-phase build plan lives in `PLAN.md`. This file
defines the rules; `PLAN.md` defines the steps.

---

## 1. Codebase Rules

- Lynx Capital is a real product simulation, not a demo-first system.
- All company-specific values, labels, copy, providers, regions, and
  scenario content live in `config/company.yaml`. Templates and Python
  code read those values at request time. No hard-coded product
  names, taglines, route copy, or scenario text inside templates or
  Python code.
- The base app uses the term **agent** in the normal product sense.
  This is the Lynx Capital codebase, not Caracal. Words like
  `principal`, `mandate`, `authority`, `delegation`, `caveat`,
  `ledger` (in the Caracal sense), and `workspace` (in the Caracal
  sense) only appear at the Caracal integration touch points
  defined in Section 7 and inside `/setup` content. Outside those
  places, prefer `agent`, `role`, `task`, `scope`, `policy`.
- Naming: short, clear, CamelCase by default. Snake_case only where
  the language requires it (Python module files, Python identifiers).
- No `new_`, `old_`, `fixed_`, `updated_`, `final_` prefixes anywhere.
- Reuse and correct existing variables instead of introducing new ones.
- No legacy paths, fallback shims, dead code, commented-out blocks,
  feature-flagged duplicate flows. Single execution path per feature.
- Use the LangChain ecosystem only: LangChain, LangGraph, DeepAgents.
  No custom orchestration frameworks, no Temporal, no Celery, no
  message brokers. The demo's own code does not introduce Docker or
  Kubernetes; the Caracal runtime is consumed as a published
  distribution per Section 7 and Phase 0 of `PLAN.md`.
- No emojis. No em dashes. No marketing copy. No filler comments.

## 2. Single Execution Mode

There is exactly one execution path. There are no `mock`, `real`,
`enforced`, or `bypass` modes. There is no `mode` query parameter, no
`mode` request body field, no environment toggle that switches
behavior at runtime.

Concretely:

- **Caracal is always on.** Every spawned agent is bound to a Caracal
  principal and mandate. Every external tool call is executed through
  the Caracal SDK so policy is enforced pre-execution. The app does
  not start successfully unless the Caracal client can be constructed
  and the active workspace is valid.
- **OpenAI is always on.** Every LLM call uses
  `langchain_openai.ChatOpenAI` configured from `config.llm`. There is
  no fallback model, no alternate provider routing, no auto-retry
  across providers. If `OPENAI_API_KEY` is missing, the app fails to
  start with a clear error.
- **External providers are always mocked.** All external API
  responses (banking, ERP, OCR, compliance, vendor portal, tax,
  FX, **and payment execution**) come from the deterministic
  case-based mock layer under `_mock/`. The mock layer is the only
  network boundary. Payment execution looks and behaves like a real
  payment path - it goes through the same enforcement, the same
  ticket lifecycle, and produces realistic case-based provider
  responses - but no real money or real network is ever touched.

The implication is that no code branches on a "mode" anywhere. The
mock service boundary is not a switch; it is the boundary. The
Caracal enforcement layer is not a switch; it is the enforcement
layer.

## 3. Architecture Rules

- The entire base system is built first as if Caracal does not exist
  (Phase 1 of `PLAN.md`). Phase 2 then layers Caracal in as
  enforcement and identity, consuming the published distribution
  delivered by Phase 0. After Phase 2, Caracal is always on; there
  is no Caracal-off path remaining.
- **Single runtime.** The UI is served by the same uvicorn process
  that serves the JSON API. There is no separate frontend
  application, no second build system, no second language. Pages are
  rendered server-side from Jinja2 templates with progressive
  enhancement via plain JavaScript modules and SSE for streaming.
- Strict separation between real app code and the `_mock` directory.
- Mock services are named like real third-party providers with a
  `.mock` suffix on the directory (for example `stripe-treasury.mock`,
  `wise-payouts.mock`, `mercury-bank.mock`, `netsuite.mock`,
  `sap-erp.mock`, `quickbooks.mock`, `compliance-nexus.mock`,
  `ocr-vision.mock`, `vendor-portal.mock`, `tax-rules.mock`,
  `fx-rates.mock`). They live only inside `_mock/` and are wired in
  through a single boundary module.
- Mock responses must be **deterministic** and **case-based**. A
  request matches one of a set of named cases by primary key (vendor,
  invoice id, amount band, region, etc.) with a `default` fallback
  per action. Same inputs always produce the same outputs.
- The mock layer must be scalable: adding a new provider, region,
  case, or scenario response requires only a new file under
  `_mock/<id>.mock/` and a registry entry, never edits to agent code.
- Backend and UI: Python 3.11+ with FastAPI, uvicorn, Jinja2,
  sse-starlette, LangChain, LangGraph, DeepAgents, and the
  `caracal_sdk` package.
- No `npm`, no `node_modules`, no Vite, no React, no bundler.

## 4. Scenario Scope

The demo executes a single realistic enterprise request:

> A global SaaS customer needs Lynx Capital to process its weekly
> payout cycle: 4,200 invoices across 5 regions (US, IN, DE, SG, BR),
> totaling ~$8.5M USD-equivalent across multiple currencies and rails,
> with constraints on fees, regional tax compliance, vendor contract
> terms, and threshold-based validation.

The system decomposes this request into a layered agent swarm:

1. **Finance Control Agent** (1) - receives request, builds graph.
2. **Regional Orchestrators** (5) - region-scoped authority.
3. **Invoice Intake Agents** (6 per region = 30) - read-only document scope.
4. **Ledger Match Agents** (4 per region = 20) - reconcile vs ERP.
5. **Policy Check Agents** (5 per region = 25) - validate; cannot execute.
6. **Route Optimization Agents** (3 per region = 15) - plan routes; advisory.
7. **Payment Execution Agents** (~3,600 ephemeral) - one transaction
   each, narrowly scoped: one vendor, one amount, one rail, one time
   window.
8. **Audit Agents** (2 per region = 10) - record full delegation lineage.
9. **Exception Agents** (~400) - investigative only, cannot execute.

Total swarm at peak: ~4,000+ agents.

For demo runtime feasibility, the swarm is **simulated faithfully**:
the topology, delegation lineage, scope partitioning, and execution
decisions are all real and traceable per agent, but a configurable
cap limits how many agents are actually instantiated as LLM-backed
LangGraph nodes per layer. The cap is set in `config/company.yaml`
under `swarm.llmBackedCap`. Beyond the cap, agents execute through a
deterministic fast path that still records full lineage and
lifecycle events. This is the only concession; nothing else is
shortened or faked.

## 5. Worker Lifecycle Rules

Every agent spawned by the system has an explicit, observable
lifecycle with four mandatory phases. Each phase emits a typed event
on the run channel and shows up in the graph view, the chat stream,
and the logs route.

1. **Spawn** - parent declares a child with `(role, scope, parent)`.
   Emits `agent_spawn` and `delegation` events. The Caracal binding
   is acquired in this phase; if binding is denied, spawn fails
   visibly and the parent records the rejection.
2. **Execute** - the agent runs, calls tools, may spawn its own
   children. Emits `agent_start`, `tool_call`, `caracal_enforce`,
   `service_call`, and `agent_end` events.
3. **Delegate** (optional) - if the agent fans out work to children,
   each child goes through its own full lifecycle and the parent
   waits for them.
4. **Terminate** - the agent releases all resources, cancels any
   outstanding tasks it owns, and emits `agent_terminate` with a
   final status (`completed`, `denied`, `failed`, `cancelled`). No
   agent may remain alive past its parent's `agent_end` unless it is
   an explicitly long-lived audit agent that terminates with the run.

Lifecycle invariants the implementation must guarantee:

- For every `agent_spawn` there is exactly one matching
  `agent_terminate` with the same agent id.
- Ephemeral agents (Payment Execution, Exception) terminate
  immediately after their single action; their `agent_terminate`
  fires before the next event of any sibling.
- A `run_end` is emitted only after every spawned agent has
  terminated.
- Cancellation propagates: when a parent cancels, all its descendants
  receive `agent_terminate` with status `cancelled` before the
  parent's own `agent_terminate`.

## 6. UI/UX Rules

- The UI is server-rendered by the uvicorn app from Jinja2 templates
  under `app/web/templates/` with static assets under
  `app/web/static/`. Live updates use SSE from the same FastAPI app.
- Light theme. Primary is a deep capital blue (`#0B3D91`) with an
  accent (`#1E5BD8`) and neutral surfaces. All colors as CSS
  variables in `app/web/static/theme.css`, populated from
  `config/company.yaml`.
- Sharp edges: border radius no greater than `4px`.
- Compact, fit-width layouts. Pages must not require long scroll.
  Each route fits a single viewport on a 1440x900 display where
  possible. Where content is naturally long (logs, swarm tree), use
  an internal scroll region with a fixed page frame.
- Multi-route navigation. Routes:
  - `GET /`         Landing (scenario summary, disclaimer, Continue).
  - `GET /setup`    Caracal CLI/TUI guided setup with live validation.
  - `GET /demo`     The single demo run page (chat + graph).
  - `GET /logs`     Color-coded runtime activity log.
  - `GET /observe`  Per-run lineage, enforcement decisions, audit.
- Short, direct copy. No long paragraphs. Headings use sentence case.
- No emojis, no decorative icons unless functional. One icon set only
  (inline SVG sprites under `app/web/static/icons.svg`).
- Persistent top nav: company name on left, route links on right.
- The `/demo` view shows, side by side: a chatbot stream (prompt ->
  tool -> result) and a live graph view (orchestration topology with
  node-state highlighting and lifecycle states as the swarm
  executes).
- The graph view must clearly express **grouping** and **fan-out**:
  - Layer groups (Finance Control, Regional Orchestrators, Intake,
    Ledger, Policy, Route, Payment, Audit, Exception) are rendered
    as labeled containers.
  - Region groups inside each layer are sub-containers, so the
    five-way regional fan-out is visually obvious.
  - Parent->children fan-out edges are drawn as bundled connectors
    that visually splay out at the child group; the bundle thickness
    reflects the number of children.
  - Per-node lifecycle state is shown as a small status pill
    (`spawned`, `running`, `completed`, `denied`, `failed`,
    `cancelled`) with the color tokens defined in `theme.css`.
- The `/logs` view is a single scrollable column of timestamped log
  lines, one per event. Each line is **color-coded by category**:
  - `caracal` (binding, enforcement allow/deny, mandate use) - blue
    family.
  - `service` (external provider mock call, request/response) -
    teal family.
  - `agent` (spawn, start, end, terminate) - neutral with a status
    accent (running=blue, completed=green, denied=red,
    cancelled=grey, failed=danger).
  - `audit` (audit-agent records) - amber family.
  - `system` (run start/end, errors, lifecycle invariants) - the
    default text color, with `error` lines in danger.
  Categories are filterable via toggle chips at the top of the page.

## 7. Caracal Integration Rules

- Caracal is consumed exclusively through its **published user-
  facing distribution**: the `caracal` CLI/TUI installed from the
  release channel (pip package, OS binary, or container image - see
  Phase 0 in `PLAN.md`) and the `caracal_sdk` Python package
  installed from PyPI. The demo never imports from `caracal/`,
  `sdk/python-sdk/src/`, or any other in-repo path. The demo never
  invokes scripts under `scripts/`, `deploy/`, or `caracal/runtime/`
  directly. If a workflow requires reaching into the monorepo, that
  is a packaging gap and is fixed upstream per Section 11 before
  the demo proceeds.
- Treat Caracal as a normal third-party dependency. Do **not**
  create a dedicated `app/caracal/` package or any other isolated
  "integration directory". Real adopters do not restructure their
  codebase around a dependency, and neither does this demo.
- Integration sits where it naturally belongs in the existing
  codebase:
  - Client construction at app startup, in `app/main.py` (or a
    small `app/runtime.py` if the startup wiring grows beyond a
    few lines).
  - Principal/mandate binding at the spawn site, in
    `app/agents/runner.py`.
  - Policy enforcement at the tool-execution site, in
    `app/agents/tools.py`.
  - Setup-state inspection (CLI subprocess) in
    `app/api/setup.py` (or a sibling helper such as
    `app/api/setup_check.py` if the helper logic is non-trivial).
  - SSE/log surfacing of `caracal_bind` and `caracal_enforce`
    events in the existing event bus and logs route, alongside
    every other event kind.
- Setup-state inspection uses the real `caracal` CLI with
  `--format json`. Runtime tool execution uses the SDK:
  `CaracalClient.context.checkout(workspace_id=...).tools.call(
  tool_id=..., tool_args=..., metadata={...})`. These are the only
  two channels the integration uses.
- SDK usage must follow the public surface precisely. No private
  attributes, no monkey-patching, no shortcut wrappers, no assumed
  undocumented behavior. If the public surface is insufficient, fix
  it upstream per Section 11.
- Integration is minimal and localized: it wraps existing call
  sites, it does not restructure them. No parallel implementations.
  No mode branching.
- Caracal vocabulary (`principal`, `mandate`, `policy`, `workspace`,
  `delegation`) is allowed only at the integration touch points
  themselves and inside `/setup` content. It must not leak into the
  base app's domain types, agent role names, or UI copy outside
  `/setup`.
- Every integration touch point must be marked with a single
  comment in the file's native comment style, beginning exactly
  with the marker phrase below. The comment appears once at the top
  of the integration block; do not repeat it inside the same block.
  Searching for `caracal-integration` must surface every touched
  location with no false positives.

  Python:
  ```
  # caracal-integration: <one-line description>
  ```
  Jinja2 / HTML:
  ```
  {# caracal-integration: <one-line description> #}
  ```
  JavaScript:
  ```
  /* caracal-integration: <one-line description> */
  ```
  YAML:
  ```
  # caracal-integration: <one-line description>
  ```

- Caracal integration responsibilities in this demo:
  1. Bind every spawned base-app agent to a Caracal principal and
     mandate during the spawn lifecycle phase.
  2. Route every external tool call through the SDK so policy is
     enforced pre-execution.
  3. Validate that Payment Execution Agents hold a mandate matching
     the exact `(vendor, amount, rail, window)` tuple before
     execution proceeds; block if not.
  4. Record every binding and enforcement decision so the
     observability and logs views can render the full lineage.
- The integration must not duplicate logic that already exists in
  the base app. It enforces; it does not reinvent.

## 8. Setup and Flow Rules

- The user configures Caracal manually via the real `caracal` CLI
  (or TUI). The UI never automates Caracal setup; it only guides and
  validates.
- The `/setup` page presents a scrollable, ordered checklist with the
  exact CLI commands to run, grouped into phases:
  1. Workspace creation and selection.
  2. Principal registration: human user, Finance Control orchestrator,
     Regional Orchestrators (5), worker layer principals (intake,
     ledger, policy, route, payment, audit, exception).
  3. Provider registration for each external service used in the
     demo.
  4. Policy creation per layer and region scope.
  5. Mandate issuance and authority delegation chains, including the
     narrow per-transaction mandate template used at the payment
     layer.
- After the user clicks Validate, the `/setup` endpoint shells out
  to the `caracal` CLI to inspect actual state and reports per-step
  pass/fail with a clear reason. Failed steps are highlighted and
  block progression to `/demo` until they pass on a re-check.

## 9. Security and Correctness

- No implicit trust of any agent. Every external action is enforced
  through Caracal.
- No bypass paths or `--skip-auth` flags. No mode that disables
  enforcement.
- Lifecycle correctness as defined in Section 5. Every spawned agent
  must be cleanly terminated; no dangling background tasks.
- Delegation is non-transitive by default. Children do not inherit a
  parent's full scope; they only receive what is explicitly delegated.
- Inputs from the UI are validated at the FastAPI boundary.
- No secrets in source. `OPENAI_API_KEY`, `CARACAL_API_KEY`,
  `CARACAL_API_URL`, and `CARACAL_WORKSPACE_ID` are read from
  environment variables only.

## 10. General Discipline

- No temporary code, TODO stubs, or placeholders left in committed
  code.
- No abstractions or helpers introduced for a single use site.
- No unused exports, configs, dependencies, or files.
- Match the surrounding code's level of abstraction exactly.
- If a piece of code cannot be justified by a current concrete need,
  it does not ship.

## 11. Upstream Caracal Fixes

This demo is built against the live Caracal codebase in the same
monorepo. If, during implementation, an edge case, logical flaw,
incorrect behavior, or missing capability is discovered in Caracal
or any of its components (core, SDK, CLI), it must be fixed in the
Caracal codebase first, before the demo proceeds.

Rules for upstream fixes:

- Fix the root cause inside Caracal. Do not work around it inside
  `examples/lynxCapital/`.
- The fix must be clean: no legacy compatibility branch, no fallback
  path, no temporary patch, no feature flag, no "TODO follow up".
  Treat the corrected behavior as the intended standard from now on.
- Update the relevant Caracal tests so they would have caught the
  defect, and verify the existing suite still passes.
- Update Caracal documentation if the fix changes a documented
  contract.
- Only after the upstream fix is in place may the demo resume
  consuming the corrected behavior through the public SDK or CLI.

The demo never duplicates Caracal logic to compensate for an
upstream defect, and never silently tolerates one.

## 12. Directory Layout

```
examples/lynxCapital/
  INSTRUCTIONS.md          this file (rules)
  PLAN.md                  three-phase, checklisted build plan
  README.md                how to run the demo
  pyproject.toml           single Python project for the whole demo
  config/
    company.yaml           company-wide values, regions, providers,
                           agent layers, swarm caps, theme, copy
  app/
    main.py                FastAPI entry, mounts API and web routers
    config.py              loads config/company.yaml
    api/                   JSON endpoints (system, run, setup,
                           observe, logs)
    core/                  domain types and synthetic dataset
    agents/                role definitions, tools, runner, lifecycle
    orchestration/         LangGraph wiring + swarm spawner + topology
    services/              external service boundary (only importer
                           of the _mock layer)
    events/                in-process event bus + SSE channels +
                           categorized log stream
    web/                   server-rendered UI
      router.py            HTML routes
      templates/           Jinja2 templates: layout, landing, setup,
                           demo, logs, observe, partials/*
      static/              theme.css, app.js, chat.js, graph.js,
                           logs.js, observe.js, icons.svg
  _mock/
    registry.yaml          maps service id -> mock module
    <service>.mock/        per-service folder: cases.json, fixtures/,
                           and any connector code needed to shape
                           realistic provider responses
```

Caracal is a dependency, not a folder. `caracal_sdk` is imported
and the `caracal` CLI is invoked from the natural integration
points inside `app/` (startup wiring, agent runner, tool layer,
setup endpoint), each marked with a single `caracal-integration:`
comment. There is no `app/caracal/` package.

The boundary between the real app and `_mock` is
`app/services/registry.py`. Service clients dispatch to the mock
layer for every external call. All mock connector code, fixtures,
and case data live under `_mock/`; nothing mock-shaped lives under
`app/`. Caracal enforcement sits between agents and the service
boundary; it never reaches into `_mock`.
