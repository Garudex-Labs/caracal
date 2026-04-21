# Mock Run — All Workers Allowed

This transcript shows a run where all four workers are active but three succeed
and one is denied by authority enforcement.

## Environment

```
CARACAL_DEMO_MODE=mock
```

## Preflight check

```
$ curl http://localhost:8090/api/preflight
{
  "passed": true,
  "checks": {
    "workspace": {"passed": true},
    "principals": {"passed": true},
    "provider": {"passed": true},
    "tools": {"passed": true},
    "tool_mapping_drift": {"passed": true},
    "policies": {"passed": true},
    "mandates": {"passed": true},
    "delegation": {"passed": true}
  }
}
```

## Trigger

```
$ curl -X POST http://localhost:8090/api/run
```

## Observed workers

| Worker | Tool called | Result |
|---|---|---|
| incidents-reader | `demo:ops:incidents:read` | success |
| deployments-reader | `demo:ops:deployments:read` | success |
| logs-reader | `demo:ops:logs:read` | success |
| denial-demo | `demo:ops:deployments:read` | enforcement_deny |

## Trace events (summary)

```
lifecycle: spawn       principal: worker-incidents-reader
lifecycle: activate    principal: worker-incidents-reader
lifecycle: spawn       principal: worker-deployments-reader
lifecycle: activate    principal: worker-deployments-reader
lifecycle: spawn       principal: worker-logs-reader
lifecycle: activate    principal: worker-logs-reader
lifecycle: spawn       principal: worker-denial-demo
lifecycle: activate    principal: worker-denial-demo
tool_call: ALLOW       tool: demo:ops:incidents:read
tool_call: ALLOW       tool: demo:ops:deployments:read
tool_call: ALLOW       tool: demo:ops:logs:read
tool_call: DENY        tool: demo:ops:deployments:read (scope mismatch)
lifecycle: cleanup     (all 4 workers)
```

## Authority Ledger

Three ALLOW entries and one DENY entry. The DENY entry on the 4th worker shows:
- `requested_action: action:ops-api:incidents:read`
- `mandate_action_scope: action:ops-api:deployments:read`
- `reason_code: MANDATE_EXPIRED` or equivalent mismatch code

