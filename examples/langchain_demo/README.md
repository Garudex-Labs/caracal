# Caracal Governed Demo

A production-grade demo of Caracal's governed execution model. An orchestrator
principal spawns short-lived worker principals, each issued a scoped JWT and
execution mandate. Workers call tools through the Caracal MCP adapter, which
enforces authority evaluation for every request. The orchestrator aggregates
results and submits a recommendation.

## Architecture

```
Customer UI (/)     → POST /api/run
                           ↓
                     DemoRuntime.execute()
                           ↓
              SpawnManager.spawn_principal()   × 3 workers
                           ↓
              asyncio.gather(*worker_tool_calls)
                           ├── scope.tools.call(demo:ops:incidents:read)
                           ├── scope.tools.call(demo:ops:deployments:read)
                           └── scope.tools.call(demo:ops:logs:read)
                           ↓
              scope.tools.call(demo:ops:recommendation:write)
                           ↓
              TraceStore.record() for every step
                           ↓
Internal UI (/caracal)  ← GET /api/traces, /api/workspace, /api/preflight
```

Every tool call goes through:
`CaracalClient → POST /mcp/tool/call → MCPAdapterService → MCPAdapter → AuthorityEvaluator → handler`

## Environment Contract

| Variable | Default | Description |
|---|---|---|
| `CARACAL_DEMO_MODE` | `mock` | `mock` or `real`. Mock uses deterministic handlers; real calls `OPS_API_URL` |
| `CARACAL_DEMO_PORT` | `8090` | Port the demo server listens on |
| `CARACAL_DEMO_LISTEN` | `0.0.0.0` | Bind address |
| `CARACAL_DEMO_WORKSPACE` | _(from ConfigManager)_ | Workspace name to use for the demo run |
| `CARACAL_DB_HOST` | `localhost` | PostgreSQL host |
| `CARACAL_DB_PORT` | `5432` | PostgreSQL port |
| `CARACAL_DB_NAME` | `caracal` | Database name |
| `CARACAL_DB_USER` | `caracal` | Database user |
| `CARACAL_DB_PASSWORD` | _(empty)_ | Database password |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis URL (required for SpawnManager nonces) |
| `OPS_API_URL` | `http://localhost:9000` | External ops API base URL (real mode only) |

## Prerequisites

1. PostgreSQL running and migrated (`alembic upgrade head`)
2. Redis running
3. Caracal workspace created and configured
4. Demo principals, provider, tools, policies, and mandates registered (see Setup below)

## Setup

### 1. Create workspace

```bash
caracal workspace create --name demo-workspace
```

### 2. Register principals

```bash
# Human (the authority root)
caracal principal register --name demo-human --kind human

# Orchestrator
caracal principal register --name demo-orchestrator --kind orchestrator

# Service account
caracal principal register --name demo-service --kind service

# Activate all three
caracal principal activate demo-human
caracal principal activate demo-orchestrator
caracal principal activate demo-service
```

### 3. Register the provider

```bash
caracal provider register \
  --name ops-api \
  --resources "incidents:read,deployments:read,logs:read,recommendation:write"
```

### 4. Register tools

```bash
# Incidents reader
caracal tool register \
  --id demo:ops:incidents:read \
  --provider ops-api \
  --resource-scope resource:ops-api:incidents \
  --action-scope action:ops-api:incidents:read \
  --tool-type logic \
  --execution-mode local \
  --handler-ref examples.langchain_demo.handlers:read_incident

# Deployments reader
caracal tool register \
  --id demo:ops:deployments:read \
  --provider ops-api \
  --resource-scope resource:ops-api:deployments \
  --action-scope action:ops-api:deployments:read \
  --tool-type logic \
  --execution-mode local \
  --handler-ref examples.langchain_demo.handlers:read_deployment

# Logs reader
caracal tool register \
  --id demo:ops:logs:read \
  --provider ops-api \
  --resource-scope resource:ops-api:logs \
  --action-scope action:ops-api:logs:read \
  --tool-type logic \
  --execution-mode local \
  --handler-ref examples.langchain_demo.handlers:read_logs

# Recommendation writer
caracal tool register \
  --id demo:ops:recommendation:write \
  --provider ops-api \
  --resource-scope resource:ops-api:recommendation \
  --action-scope action:ops-api:recommendation:write \
  --tool-type logic \
  --execution-mode local \
  --handler-ref examples.langchain_demo.handlers:submit_recommendation
```

### 5. Issue mandates

```bash
# Human → Orchestrator
caracal authority mandate issue \
  --issuer demo-human \
  --subject demo-orchestrator \
  --resource-scope "resource:ops-api:*" \
  --action-scope "action:ops-api:*"

# (Workers are spawned at runtime by the orchestrator; they receive
# sub-mandates automatically via SpawnManager)
```

### 6. Verify readiness

```bash
# Check all preflight conditions pass
curl http://localhost:8090/api/preflight | python3 -m json.tool
```

The `/` UI also shows a workspace readiness checklist.

## Running the Demo

```bash
CARACAL_DEMO_MODE=mock uvicorn examples.langchain_demo.app:app --port 8090
```

Then open:
- `http://localhost:8090/` — Customer-facing UI with run controls and results
- `http://localhost:8090/caracal` — Internal observability: principals, traces, preflight, ledger
- `http://localhost:8090/docs` — FastAPI auto-generated API docs

## Running Smoke Tests

```bash
cd /path/to/Caracal
CARACAL_DEMO_MODE=mock pytest examples/langchain_demo/tests/test_demo_smoke.py -v
```

## File Map

| File | Purpose |
|---|---|
| `app.py` | FastAPI app; reuses `MCPAdapterService.app` and adds demo routes |
| `demo_runtime.py` | `DemoRuntime.execute()` — orchestrator fan-out, worker lifecycle, aggregation |
| `handlers.py` | Local logic tool handlers (4 tools; mock + real modes) |
| `mock_services.py` | `MockTransport` — deterministic HTTP responses for outbound provider calls |
| `preflight.py` | `WorkspacePreflight` — 8-check workspace readiness validator |
| `trace_store.py` | `TraceStore` — thread-safe in-memory trace event aggregation |
| `tests/test_demo_smoke.py` | Smoke tests: handlers, transport, trace store, runtime, preflight |

## Tool Call Flow (Mock Mode)

1. `DemoRuntime` spawns worker via `SpawnManager.spawn_principal()`
2. Sets `attestation_status = ATTESTED`, transitions lifecycle to `ACTIVE`
3. Issues worker JWT via `SessionManager.issue_session()` (ES256)
4. `CaracalClient(api_key=worker_token).context.checkout(workspace_id)`
5. `scope.tools.call(tool_id, tool_args)` → `POST /mcp/tool/call`
6. `MCPAdapterService` validates JWT, extracts `principal_id` from `sub` claim
7. `AuthorityEvaluator` checks mandate chain and scope
8. `MCPAdapter` dispatches to `handlers.py` handler (execution_mode=local)
9. Handler checks `CARACAL_DEMO_MODE` → returns deterministic mock data
10. Result propagates back through the chain
11. Worker is deactivated (`transition_lifecycle_status("deactivated")`)
