# Demo Runbook

## Overview

This runbook covers operating the Caracal governed demo in mock and real modes.
The demo runs four parallel workers under full authority enforcement: three read
tools that succeed and one intentionally denied to show enforcement in action.

## Prerequisites

1. PostgreSQL running with `alembic upgrade head` applied
2. Redis running
3. Demo workspace configured (see `examples/langchain_demo/README.md`)

## Starting the Server

**Mock mode** (no external deps, deterministic handlers):

```bash
CARACAL_DEMO_MODE=mock uvicorn examples.langchain_demo.app:app --port 8090
```

**Real mode** (live Caracal workspace, PostgreSQL, Redis):

```bash
uvicorn examples.langchain_demo.app:app --port 8090
```

## Preflight

Before triggering a run, verify workspace readiness:

```bash
curl http://localhost:8090/api/preflight | python3 -m json.tool
```

All 9 checks must show `"passed": true`. If any fail, inspect the `detail` field
for what is missing (missing principal kind, provider not found, mandate gap, etc.).

The customer UI at `http://localhost:8090/` also shows the readiness checklist inline.

## Triggering a Run

```bash
curl -X POST http://localhost:8090/api/run | python3 -m json.tool
```

Expected shape:

```json
{
  "run_id": "...",
  "workers": [
    { "label": "incidents-reader",   "result_type": "success" },
    { "label": "deployments-reader", "result_type": "success" },
    { "label": "logs-reader",        "result_type": "success" },
    { "label": "denial-demo",        "result_type": "enforcement_deny",
      "denial_reason": "authority denied" }
  ]
}
```

## Viewing Results

| URL | What it shows |
|---|---|
| `http://localhost:8090/` | Worker fan-out grid with enforcement badges |
| `http://localhost:8090/caracal` | Operator view: Preflight, Principals, Tools, Mandates, Delegation, Authority Ledger, Traces |
| `GET /api/traces` | Raw trace events (last 200) |
| `GET /api/authority_ledger` | Authority decisions with reason codes |

## Verifying Enforcement

The 4th worker (`denial-demo`) is intentionally denied. It presents:
- tool: `demo:ops:deployments:read` (action scope: `action:ops-api:deployments:read`)
- requested action: `action:ops-api:incidents:read` (scope mismatch)

In the Authority Ledger section of `/caracal` you should see a DENY event with
`reason_code: MANDATE_EXPIRED` or similar for this worker. The customer UI shows
a red enforcement badge for that worker slot.

## Mock vs Real Mode

| Feature | `mock` | `real` |
|---|---|---|
| Transport | `MockTransport` (registry-based) | Live `OPS_API_URL` |
| Credentials | Placeholder JWTs | Real ES256 keypairs via SpawnManager |
| Authority evaluation | Full (in-process) | Full (PostgreSQL-backed) |
| Worker spawn | Real `SpawnManager` | Real `SpawnManager` |
| Enforcement path | Identical | Identical |

