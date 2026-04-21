# Governed Mock Transcript — Enforcement Visible

This transcript shows a full governed run in mock mode with enforcement active.

## Environment

```
CARACAL_DEMO_MODE=mock
```

## Trigger

```
$ curl -X POST http://localhost:8090/api/run
```

## Response

```json
{
  "run_id": "a1b2c3d4-...",
  "workers": [
    {
      "label": "incidents-reader",
      "principal_id": "...",
      "result_type": "success",
      "denial_reason": null,
      "data": { "incident_id": "INC-001", "severity": "high" }
    },
    {
      "label": "deployments-reader",
      "principal_id": "...",
      "result_type": "success",
      "denial_reason": null,
      "data": { "deployment_id": "DEP-042", "status": "healthy" }
    },
    {
      "label": "logs-reader",
      "principal_id": "...",
      "result_type": "success",
      "denial_reason": null,
      "data": { "log_count": 12, "error_count": 1 }
    },
    {
      "label": "denial-demo",
      "principal_id": "...",
      "result_type": "enforcement_deny",
      "denial_reason": "authority denied",
      "data": null
    }
  ]
}
```

## Enforcement Evidence

In the `/caracal` operator UI → Authority Ledger section:

```
ALLOW  incidents-reader   action:ops-api:incidents:read    → success
ALLOW  deployments-reader action:ops-api:deployments:read  → success
ALLOW  logs-reader        action:ops-api:logs:read          → success
DENY   denial-demo        action:ops-api:incidents:read     ← scope mismatch
```

The denial-demo worker requested `action:ops-api:incidents:read` but its spawned
mandate was scoped to `action:ops-api:deployments:read`. Caracal enforced the
boundary before the handler ran.

## Outcome

- 3 workers: success
- 1 worker: enforcement_deny (expected)
- Authority ledger: 4 entries (3 ALLOW, 1 DENY)
- Trace events: spawn/activate/call/cleanup for all 4 workers

