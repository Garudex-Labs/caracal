# Lynx Capital Demo - Build Plan

This file is the executable build plan. It is paired with
`INSTRUCTIONS.md`, which defines the rules. Read `INSTRUCTIONS.md`
first.

The plan is split into three strict phases. A phase is complete only
when every item is `[X]` and the phase's validation criteria pass.
Do not start the next phase until the current one is closed.

Statuses: `[ ]` not started, `[~]` in progress, `[X]` complete.

There is **one execution mode** in this demo. Caracal and OpenAI are
always on. External providers (including payments) are mocked only
at the service boundary. There is no `mode` parameter, no fallback
LLM, no Caracal-off path.

The demo consumes Caracal **only** through its published user-
facing distribution (CLI, TUI, SDK, runtime image). Phase 0 below
captures the upstream packaging refactor that delivers that
distribution. The demo does not begin Phase 1 implementation until
Phase 0 ships a working `pip install caracal` (CLI + TUI) and
`pip install caracal-sdk` flow that does not require any path into
this monorepo.

---

## Phase 0 - Upstream Caracal distribution refactor

Goal: Caracal is shipped as a clean, user-facing distribution that
external projects (including this demo) consume the same way a real
adopter would. No reliance on the monorepo layout, no dev-only
scripts in the user path, no internal modules leaking into the
public surface.

This phase modifies the **Caracal codebase**, not the demo. It must
land before Phase 1 of the demo starts. Each task lists the work
in Caracal's own repo; the demo's Phase 1+ files are not touched
here.

### P0.1 Audit current packaging surface  [X]

- [X] Inventory every artifact a real user would need: `caracal`
      CLI, `caracal` TUI, `caracal_sdk` Python package, vault
      sidecar image, runtime container image, Docker Compose
      bundle, alembic migrations, and the host-side launcher under
      `caracal/runtime/entrypoints.py`.
- [X] Inventory every monorepo-only path currently exposed to
      users: `scripts/*.sh`, `deploy/docker-compose*.yml` paths,
      `alembic.ini` location, `caracal/runtime/host_io.py` env
      hooks, in-tree migration runner, etc.
- [X] Produce a written gap list (in `caracal/PACKAGING.md` or
      similar inside the Caracal repo) of what a fresh `pip install`
      gets vs. what is actually needed to run the system end to
      end.

### P0.2 Define the public distribution units  [X]

Three published units, each with a stable name, semantic version,
and minimal dependency set:

- [X] `caracal` (PyPI): user-facing CLI + TUI + the small launcher
      that brings the runtime up via container or local mode.
      Console scripts: `caracal` (CLI/TUI). Depends on
      `caracal-sdk` and on packaged runtime assets, not on the
      server's full dependency tree.
- [X] `caracal-sdk` (PyPI): Python SDK only. No server deps. Already
      exists; verify it has zero imports from `caracal/` and a
      stable `__all__`.
- [X] `caracal-runtime` (container image, published to a registry):
      server, vault sidecar wiring, postgres + redis service
      definitions, alembic migrations baked in, started by the
      `caracal` CLI via `caracal up`. Internal Python packages
      (`caracal.core`, `caracal.db`, `caracal.identity`,
      `caracal.merkle`, `caracal.enterprise`, `caracal.flow`,
      `caracal.mcp`, `caracal.provider`, `caracal.redis`,
      `caracal.storage`, `caracal.monitoring`, `caracal.deployment`)
      live inside this image and are not redistributed as PyPI
      modules to end users.

The current `caracal-core` PyPI package is renamed/retired in favor
of this split. Internal server modules stop being PyPI-installable
for external users; they remain importable inside the container
image and inside the Caracal repo for tests.

### P0.3 Restructure the Python packaging  [X]

In the Caracal repo:

- [X] Create `packages/caracal/` with its own `pyproject.toml`
      defining the `caracal` PyPI package. This is a thin
      orchestrator wheel: only `runtime/entrypoints.py`,
      `runtime/host_io.py`, `runtime/hardcut_preflight.py`,
      `runtime/environment.py`, `_version.py`, and `pathing.py`
      live here. Its only runtime dependency is `python-dotenv`.
- [X] Move every other module (`cli`, `flow`, `core`, `db`,
      `identity`, `merkle`, `enterprise`, `mcp`, `provider`,
      `redis`, `storage`, `monitoring`, `deployment`, `config`,
      plus `exceptions.py`, `logging_config.py`, and
      `runtime/restricted_shell.py`) under
      `packages/caracal-server/` with its own `pyproject.toml`.
      `cli/` and `flow/` ship server-side because their imports
      reach deeply into server-internal modules; the user-facing
      surface is the published `caracal` console script which
      execs into the runtime container. This package is **not
      published to PyPI** (`Private :: Do Not Upload`); it is
      installed into the runtime container image only.
- [X] Both wheels register the `caracal` namespace via PEP 420
      implicit namespace packages (no top-level `__init__.py` in
      either source tree). After install, `caracal.__path__`
      spans both wheel sources.
- [X] Keep `sdk/python-sdk/` as the source of `caracal-sdk`; it
      remains free of server imports (verified in P0.2).
- [X] Replace the workspace root `pyproject.toml` with a
      `[tool.uv.workspace]` declaration enumerating
      `packages/caracal`, `packages/caracal-server`,
      `sdk/python-sdk`. Pytest, coverage, ruff, black, and mypy
      config remain at the workspace root.
- [X] `uv sync --all-packages` installs all three editable wheels.
      Test suite green: 1186 passed (vs. baseline 703 passed; the
      uplift is from uv installing pytest plugins that enabled
      previously-skipped tests). Only the two pre-existing
      baseline failures remain (`test_gateway`, rate-limiting).

### P0.4 Embed runtime assets in the user package  [X]

The `caracal` CLI today reads `deploy/docker-compose*.yml`,
`alembic.ini`, and `scripts/*.sh` paths from the repo. After this
task, none of those repo paths are required at runtime.

- [X] Embed the runtime Docker Compose file as package data inside
      the `caracal` PyPI package (`importlib.resources`-loaded);
      drop the `CARACAL_DOCKER_COMPOSE_FILE` repo-path fallback in
      `caracal/runtime/entrypoints.py`.
- [X] Move `alembic.ini` and the migration scripts into the
      runtime image; the user-facing `caracal migrate` command
      runs them inside the container.
- [X] Replace shell scripts under `scripts/` that users currently
      invoke (`backup-postgresql.sh`, `restore-postgresql.sh`,
      `generate-certs.sh`, `setup-redis-security.sh`,
      `event-replay-recovery.sh`) with first-class
      `caracal backup`, `caracal restore`, `caracal certs`,
      `caracal redis init`, `caracal events replay` subcommands
      that execute inside the runtime container.

### P0.5 Vault distribution  [X]

- [X] Pin the vault sidecar image and credentials story in the
      published Compose definition. Document the production
      configuration knobs (`CARACAL_VAULT_SIDECAR_*` env vars) in
      the user docs, not in the repo README only.
- [X] Provide a `caracal vault init` subcommand that performs
      first-run vault setup (generate auth secret + encryption key,
      seal/unseal flow, root token bootstrap) without the user
      reading source code.

### P0.6 Single CLI/TUI entry point  [X]

- [X] One `caracal` console script. `caracal` with no args opens
      the TUI; `caracal <subcommand>` runs the CLI. The current
      split between `caracal/cli/main.py` and `caracal/flow/`
      collapses into one entry point with the same UX whether
      invoked locally or from inside the runtime container.
- [X] All subcommands documented by `caracal --help` reflect the
      published surface only; internal/dev commands (anything used
      only for monorepo development) are removed from the user
      path or hidden behind `--internal`.

### P0.7 Release and verification  [X]

- [X] Build wheels for `caracal` and `caracal-sdk`; build and push
      the `caracal-runtime` image to the chosen registry under a
      pinned tag (e.g. `caracal-runtime:0.1.0`).
- [X] In a clean container with no access to the Caracal monorepo,
      verify:
  - `pip install caracal caracal-sdk` succeeds with no editable
    paths.
  - `caracal --help` lists the user surface.
  - `caracal up` pulls the runtime image and brings up the full
    stack (server + vault + postgres + redis).
  - `caracal workspace create` and the rest of the `/setup` flow
    used by the demo work end to end.
  - `python -c "from caracal_sdk import CaracalClient"` works and
    can call `tools.call(...)` against the running runtime.
- [X] None of the steps above reference any path inside the
      Caracal monorepo.

### Phase 0 acceptance  [X]

- [X] `pip install caracal caracal-sdk` is the only install step
      required for the Lynx Capital demo.
- [X] The demo's `/setup` checklist references only the published
      `caracal` subcommands, not `scripts/*.sh` or repo-relative
      Compose paths.
- [X] No public-facing artifact imports or invokes anything under
      `caracal/core/`, `caracal/db/`, `caracal/identity/`,
      `caracal/merkle/`, `caracal/enterprise/`, `caracal/mcp/`,
      `caracal/provider/`, `caracal/redis/`, `caracal/storage/`,
      `caracal/monitoring/`, or `caracal/deployment/` from outside
      the runtime image.
- [X] The Caracal repo README's quickstart matches the user
      experience exactly.

### Phase 0 Do / Do Not

Do:
- Treat the published distribution as the only supported user
  path; the monorepo is a development environment, nothing more.
- Land each rename/move with a corresponding deprecation removed;
  no parallel old/new packages.
- Keep server-only code out of the user-facing wheel.

Do not:
- Add a "use the repo paths" fallback for any user-facing command.
- Publish internal server modules to PyPI.
- Ship a packaging story that requires the user to clone the
  monorepo to do anything other than contribute to Caracal itself.

---

## Phase 1 - Base codebase, Caracal-free

Goal: A runnable Lynx Capital app that simulates the full finance
swarm with deterministic mocks, server-rendered UI, OpenAI LLM, full
worker lifecycle events, and a `/logs` view. No Caracal yet.

### P1.1 Project skeleton  [X]

- [X] `pyproject.toml` with deps: `fastapi`, `uvicorn[standard]`,
      `jinja2`, `sse-starlette`, `pydantic>=2`, `pyyaml`,
      `langchain`, `langchain-openai`, `langgraph`, `deepagents`,
      `httpx`, `python-dotenv`.
- [X] `app/main.py`: FastAPI app, mounts `app/api` JSON router,
      `app/web/router.py` HTML router, static files, startup hook
      that loads config and validates `OPENAI_API_KEY`.
- [X] `app/config.py`: loads `config/company.yaml` once, exposes a
      typed `AppConfig` object.
- [X] `config/company.yaml` with: company identity, theme colors,
      regions, providers, agent layers, swarm caps, copy.
- [X] `README.md`: how to run with `uvicorn app.main:app --reload`
      and required env vars.

Files created: `pyproject.toml`, `app/__init__.py`, `app/main.py`,
`app/config.py`, `config/company.yaml`, `README.md`.

### P1.2 Domain core  [X]

- [X] `app/core/types.py`: typed models for `Region`, `Vendor`,
      `Invoice`, `PayoutPlan`, `PaymentTicket`, `LedgerEntry`,
      `PolicyDecision`, `Rail`.
- [X] `app/core/dataset.py`: deterministic generator producing 4,200
      invoices across 5 regions with a fixed seed; vendor catalog,
      contract terms, FX inputs.

### P1.3 Mock service boundary  [X]

- [X] `_mock/registry.yaml`: maps service id to mock module.
- [X] One `_mock/<service>.mock/cases.json` per provider:
      `mercury-bank`, `wise-payouts`, `stripe-treasury`, `netsuite`,
      `sap-erp`, `quickbooks`, `compliance-nexus`, `ocr-vision`,
      `vendor-portal`, `tax-rules`, `fx-rates`. Cases are matched by
      primary key (vendor / invoice / amount band / region) with a
      `default` fallback per action. Output shapes mirror real
      provider responses exactly.
- [X] `app/services/registry.py`: loads `_mock/registry.yaml`, exposes
      `call(service_id, action, payload) -> dict` that dispatches
      deterministically. This is the **only** importer of `_mock`.
- [X] `app/services/clients.py`: typed thin clients per service that
      call into `registry.call(...)`. These are what agents use.
- [X] Payment execution provider returns realistic case-based
      acknowledgments (`tx_id`, `status`, `posted_at`, `rail`,
      `fee`); no random values.

### P1.4 Event bus and lifecycle taxonomy  [X]

- [X] `app/events/bus.py`: in-process pub/sub keyed by `runId`.
      Retains full history per run for replay.
- [X] `app/events/types.py`: typed events with explicit `category`
      and `kind` fields. Categories and kinds:
  - `system`: `run_start`, `run_end`, `error`.
  - `agent`: `agent_spawn`, `agent_start`, `agent_end`,
    `agent_terminate`.
  - `delegation`: `delegation`.
  - `tool`: `tool_call`, `tool_result`.
  - `service`: `service_call`, `service_result`.
  - `caracal`: `caracal_bind`, `caracal_enforce` (Phase 2).
  - `audit`: `audit_record`.
- [X] `app/events/sse.py`: per-run SSE stream and a global
      categorized log stream consumed by `/logs`.

### P1.5 Agent runner with explicit lifecycle  [X]

- [X] `app/agents/runner.py`: `AgentRunner.spawn(role, scope, parent)`
      returns an `AgentHandle` and emits `agent_spawn`. Every spawn
      must be followed by exactly one `agent_terminate` for the
      same agent id; the runner enforces this invariant.
- [X] LLM-backed agents up to `swarm.llmBackedCap`; deterministic
      fast path beyond the cap. Both paths emit the same lifecycle,
      tool, and service events.
- [X] Cancellation: depth-first `agent_terminate(status="cancelled")`
      across all descendants before the parent terminates.
- [X] Ephemeral agents: `terminate` fires immediately after their
      single action completes.

### P1.6 Agent role catalog  [X]

- [X] `app/agents/roles.py`: definitions for every layer in
      Section 4 of `INSTRUCTIONS.md`. Each role declares
      `(name, scope_template, allowed_tools, emits)`.
- [X] `app/agents/tools.py`: tool wrappers around `app.services.clients`
      with strict argument schemas. Tools emit `tool_call` /
      `tool_result` and wrap underlying `service_call` /
      `service_result` events.

### P1.7 Orchestration  [X]

- [X] `app/orchestration/topology.py`: builds the Lynx Capital
      orchestration graph (Finance Control -> Regional Orchestrators
      -> per-region worker layers -> per-transaction Payment
      Execution agents) with explicit grouping metadata
      (`layer`, `region`) on every node so the graph view can render
      groups and fan-out.
- [X] `app/orchestration/swarm.py`: spawns the agents per the
      topology, respecting `swarm.llmBackedCap`, while emitting full
      lifecycle events for every node (LLM-backed and fast-path).
- [X] `app/orchestration/coordinator.py`: a `langgraph.StateGraph`
      that drives the layer-by-layer flow and waits for child
      terminations before advancing.

### P1.8 API layer  [X]

- [X] `app/api/system.py`: `GET /api/system/health`,
      `GET /api/system/config`.
- [X] `app/api/run.py`:
  - `POST /api/run/start` body `{prompt}` -> `{runId}`. No `mode`.
  - `GET /api/run/{runId}/events` SSE per-run event stream.
  - `GET /api/run/{runId}/lineage` JSON lineage tree, including
    lifecycle state per agent.
  - `GET /api/run/{runId}/graph` JSON graph: nodes carry
    `{id, role, layer, region, parent, status}`, edges carry
    `{from, to, kind}`.
- [X] `app/api/logs.py`:
  - `GET /api/logs/recent?runId=...&category=...` JSON tail.
  - `GET /api/logs/stream?runId=...` SSE stream of categorized log
    lines.
- [X] `app/api/observe.py`: per-run lineage, decisions, audit (Phase 2
      fills enforcement; in Phase 1 it returns lifecycle + service
      events).

### P1.9 Web UI: layout, landing, demo, logs  [X]

- [X] `app/web/router.py`: `GET /`, `GET /demo`, `GET /logs`,
      `GET /observe`. Setup route is added in Phase 2.
- [X] `app/web/templates/layout.html`: top nav with company name and
      route links pulled from config.
- [X] `app/web/templates/landing.html`: scenario summary, disclaimer
      checkbox, Continue.
- [X] `app/web/templates/demo.html`: split view, chat on left, graph
      on right, footer with run controls. Single page; no mode
      switch.
- [X] `app/web/templates/logs.html`: filterable categorized log view.
- [X] `app/web/static/theme.css`: CSS variables seeded from
      `config/company.yaml`. Includes color tokens per log category
      (`--logCaracal`, `--logService`, `--logAgent`, `--logAudit`,
      `--logSystem`) and lifecycle status colors (`--statusSpawned`,
      `--statusRunning`, `--statusCompleted`, `--statusDenied`,
      `--statusFailed`, `--statusCancelled`).
- [X] `app/web/static/app.js`: shared boot, nav highlight.
- [X] `app/web/static/chat.js`: subscribes to SSE, renders prompt ->
      tool -> result with lifecycle markers.
- [X] `app/web/static/graph.js`: renders the orchestration topology
      with **grouping** by layer and region, **fan-out** edges
      (bundled connectors splaying at the child group, thickness
      reflecting child count), per-node lifecycle status pill, and
      live updates as events arrive. Uses inline SVG; no external
      libs.
- [X] `app/web/static/logs.js`: subscribes to `/api/logs/stream`,
      renders one line per event with the category color token,
      supports category filter chips.

### P1.10 Validation harness  [X]

- [X] `tests/test_lifecycle.py`: every `agent_spawn` has exactly one
      `agent_terminate` with the same agent id; cancellation
      propagates depth-first; ephemeral agents terminate before any
      sibling event.
- [X] `tests/test_mock_determinism.py`: same inputs to every service
      produce same outputs across 100 runs.
- [X] `tests/test_topology.py`: graph contains all required layers
      and per-region groupings; counts match config caps.

### Phase 1 acceptance  [X]

- [X] `uvicorn app.main:app` starts cleanly.
- [X] `GET /` renders. `GET /demo` renders chat + graph. `GET /logs`
      renders categorized live log. `GET /observe` renders lineage.
- [X] Submitting the scenario prompt drives a full simulated run end
      to end with deterministic mock output.
- [X] The lineage tree shows full layer and per-transaction
      decomposition with **complete lifecycle**: every agent has
      `spawn`, `start`, `end`, `terminate` events.
- [X] The graph view renders layer + region groups and fan-out
      bundles; node status pills update live.
- [X] The `/logs` view shows color-coded entries across all
      categories (`agent`, `service`, `tool`, `audit`, `system`)
      with working filters.
- [X] Phase 1 lifecycle and determinism tests pass.

### Phase 1 Do / Do Not

Do:
- Build the entire base flow as if Caracal is unrelated to it.
- Make every external call go through `app/services/registry.py`.
- Render the UI from Jinja2 templates served by the same uvicorn
  process.
- Emit lifecycle events for every spawned agent including
  ephemeral payment agents.

Do not:
- Import `caracal_sdk` anywhere in Phase 1.
- Add a `mode` parameter, query string, or env toggle.
- Add a fallback LLM provider.
- Add console-log debug statements to any committed file.

---

## Phase 2 - Caracal integration

Goal: Caracal becomes the unconditional identity, authority, and
enforcement layer. Every spawned agent is bound; every external tool
call is enforced. The base app's call sites are wrapped, not
restructured.

Prerequisite: Phase 0 must be `[X]`. Phase 2 installs and consumes
only the published artifacts: `pip install caracal-sdk` for the
SDK and `pip install caracal` for the CLI/TUI used by `/setup`. No
path inside the Caracal monorepo is referenced.

### P2.0 Add published Caracal artifacts to the demo  [X]

- [X] Add `caracal-sdk` and `caracal` to the demo's
      `pyproject.toml` dependencies, pinned to the versions
      published in Phase 0. No `tool.uv.sources` overrides, no
      editable installs, no path references.
- [X] Document in `README.md` that `caracal --help` must work after
      `pip install -e .` of the demo.

### P2.1 Caracal client and binding  [X]

All SDK usage in this phase must follow the public `caracal_sdk`
patterns precisely: construct `CaracalClient` via its documented
constructor, acquire a `ScopeContext` through
`client.context.checkout(workspace_id=...)`, and execute tools via
`scope.tools.call(tool_id=..., tool_args=..., metadata={...})`. No
private attributes, no monkey-patching, no shortcut wrappers, no
assumed undocumented behavior. If the SDK's public surface does not
support a needed operation, fix it upstream per the rule in
`INSTRUCTIONS.md` Section 11 rather than working around it here.

Caracal is treated as a normal third-party dependency. Do **not**
create an `app/caracal/` package or any other isolated integration
folder. The integration lives where it naturally belongs in the
existing codebase, marked with a single `caracal-integration:`
comment per touch point.

- [X] **Startup wiring** in `app/main.py` (or a small
      `app/runtime.py` if the wiring grows past a few lines):
      construct `CaracalClient` from `CARACAL_API_KEY`,
      `CARACAL_API_URL`, and `CARACAL_WORKSPACE_ID` at app startup
      and store the workspace-checked-out `ScopeContext` on
      `app.state`. Failure to construct the client or check out the
      workspace is a fatal startup error.
- [X] **Binding helper** added to `app/agents/runner.py` (or a
      sibling `app/agents/identity.py` if it would otherwise dwarf
      the runner): a single function `bind_principal(role, scope,
      parent)` that maps a base-app `(role, scope, parent)` to a
      Caracal principal id and mandate. It selects the per-
      transaction mandate template for the payment layer. The
      binding is cached per run. Result objects emit a
      `caracal_bind` event (allowed) or `caracal_bind` with
      `decision="denied"`.
- [X] **Enforcement helper** added to `app/agents/tools.py`: a
      single function `enforce_call(binding, service_id, action,
      payload)` that computes the canonical tool id
      `provider:<service_id>:resource:<r>:action:<a>` and calls
      `app.state.caracal.tools.call(tool_id=..., tool_args=payload,
      metadata={"correlation_id": ...})`. Emits a `caracal_enforce`
      event with the decision and reason. Returns the SDK response
      body unchanged on allow; surfaces the SDK's deny reason
      verbatim on deny.
- [X] **Setup-state inspection** in `app/api/setup.py` (with a
      sibling `app/api/setup_check.py` only if the helper logic is
      non-trivial): shells out to the public `caracal` CLI -
      `caracal workspace`, `caracal principal`, `caracal provider`,
      `caracal policy`, `caracal authority`, `caracal delegation` -
      with `--format json` and reports per-step pass/fail.

### P2.2 Wire enforcement into existing call sites  [X]

- [X] In `app/agents/runner.py`, the spawn lifecycle phase calls
      `bind_principal(role, scope, parent)` before the agent can
      execute. Add the single `# caracal-integration:` marker
      comment at the top of that block.
- [X] In `app/agents/tools.py`, every tool wrapper routes its
      external call through `enforce_call(...)` instead of calling
      `app.services.clients` directly. Add the single
      `# caracal-integration:` marker comment at the top of the
      tool-execution block. A denial produces a `tool_result` of
      kind `denied`, the agent terminates with `status="denied"`,
      and the deny reason is preserved.
- [X] Payment Execution agents additionally validate, before
      `enforce_call`, that the held mandate matches the exact
      `(vendor, amount, rail, window)` tuple. Mismatch causes an
      immediate denial event and the agent terminates with
      `status="denied"`.

### P2.3 Setup route  [X]

- [X] `GET /setup` template + JSON endpoint that renders the ordered
      checklist with exact `caracal` commands grouped into:
      workspace, principals, providers, policies, mandates &
      delegation.
- [X] Validate button calls the setup-state inspection in
      `app/api/setup.py` and renders pass/fail with a clear reason
      per step. Failed steps block `/demo` until they pass on a
      re-check.

### P2.4 Observability and logs surface enforcement  [X]

- [X] `/observe` shows per-run lineage with the bound principal,
      mandate id, and every enforcement decision per tool call.
- [X] `/logs` includes `caracal` category lines for every bind and
      enforce event with their own color token (`--logCaracal`).
- [X] `tests/test_enforcement.py`: a deliberate over-scope payment
      attempt is denied; the run still completes with the affected
      ephemeral agent terminating cleanly with `status="denied"`.

### Phase 2 acceptance  [X]

- [X] App fails to start if `CARACAL_API_KEY`, `CARACAL_API_URL`, or
      `CARACAL_WORKSPACE_ID` are missing or invalid.
- [X] Every spawned agent has a `caracal_bind` event in its
      lifecycle.
- [X] Every tool call has a corresponding `caracal_enforce` event
      preceding the underlying `service_call`.
- [X] `/setup` correctly validates a working configuration and
      correctly fails on a deliberately broken one.
- [X] `tests/test_enforcement.py` passes.
- [X] `caracal_sdk` is imported and the `caracal` CLI is invoked
      only at the documented integration touch points
      (startup wiring, agent runner, tool layer, setup endpoint),
      each carrying a single `caracal-integration:` marker.
- [X] No code path bypasses enforcement; no `mode` parameter exists.

### Phase 2 Do / Do Not

Do:
- Treat Caracal as a normal dependency. Integrate at the natural
  call sites in existing files; create a new module only when
  inlining would clearly hurt readability.
- Mark every integration touch point with the
  `caracal-integration:` comment exactly once at the top of the
  block.
- Treat enforcement as unconditional. If Caracal cannot be reached,
  the run fails loudly.

Do not:
- Create an `app/caracal/` package or any other isolated
  integration directory.
- Add a "Caracal disabled" code path.
- Re-implement Caracal logic in the demo. Just call the SDK and
  CLI.

---

## Phase 3 - UI polish, validation, demo readiness

Goal: The app looks and feels like an internal Lynx Capital tool.
The `/demo`, `/logs`, and `/observe` views are tight, fit-width,
and visually communicate parallel execution and fan-out. The setup
flow is bulletproof.

### P3.1 Theme and layout  [ ]

- [ ] Final theme tokens in `theme.css` driven entirely by
      `config/company.yaml`.
- [ ] Persistent top nav, fit-width pages, no overlong scroll on
      primary routes.

### P3.2 Landing and setup  [ ]

- [ ] Landing renders scenario summary, key numbers (4,200 invoices,
      ~$8.5M, 5 regions, ~4,000 agents at peak), disclaimer
      checkbox, Continue button enabled only when checked.
- [ ] Setup checklist with copy-to-clipboard for each command,
      collapsible per-phase, persistent pass/fail state.

### P3.3 Demo view  [ ]

- [ ] Single `/demo` page (no mode switch).
- [ ] Chat panel: streamed events grouped per agent with lifecycle
      markers (`spawn`, `running`, `done`, `terminated`,
      `denied`).
- [ ] Graph panel: layer bands top to bottom (Finance Control ->
      Regional Orchestrators -> Intake/Ledger/Policy/Route ->
      Payment Execution -> Audit/Exception). Within each band,
      region columns. Fan-out edges drawn as bundled splaying
      connectors with thickness keyed to child count. Each node
      shows a status pill that updates live.
- [ ] Run controls: Start, Pause, Cancel. Cancel propagates and is
      reflected in lifecycle events and node colors.

### P3.4 Logs view  [ ]

- [ ] Single `/logs` page with category filter chips
      (`caracal`, `service`, `tool`, `agent`, `audit`, `system`).
- [ ] Each line: timestamp, category badge (color-coded), short
      summary, expandable JSON detail.
- [ ] Live tail via SSE; pause/resume; clear filters control.
- [ ] Color tokens come from `theme.css`; no inline colors.

### P3.5 Observe view  [ ]

- [ ] Lineage tree per run with bound principal, mandate id,
      enforcement decision per call, and final lifecycle status per
      agent.

### P3.6 End-to-end validation  [ ]

- [ ] Manual run-through script in `README.md` covering: install,
      env, `caracal` setup commands, `/setup` validation, `/demo`
      run, `/logs` and `/observe` review.
- [ ] All Phase 1 and Phase 2 tests still pass.
- [ ] `grep` for `caracal-integration` lists every and only the
      integration touch points.
- [ ] `grep` for `mode=` and `mock_mode` returns nothing in app
      code.
- [ ] `grep` for `principal|mandate|authority|delegation|workspace`
      in `app/` returns matches only at the documented
      `caracal-integration:` blocks and inside
      `app/web/templates/setup.html`.

### Phase 3 acceptance  [ ]

- [ ] Visual review: pages fit a 1440x900 viewport without primary
      scroll.
- [ ] Demo run produces a coherent end-to-end story across chat,
      graph, logs, and observe views.
- [ ] Cancellation mid-run is clean and visible everywhere.
- [ ] No emojis, no marketing copy, no stray TODOs.

### Phase 3 Do / Do Not

Do:
- Drive every visible string from `config/company.yaml`.
- Keep the visual language consistent across all routes.
- Make fan-out and parallelism legible at a glance.

Do not:
- Introduce a frontend framework.
- Re-add a mode switch in any form.
- Add cosmetic features that do not serve the demo's narrative.
