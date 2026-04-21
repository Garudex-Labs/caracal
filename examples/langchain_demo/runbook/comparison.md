# Enforcement Demonstration

This demo makes authority enforcement explicit through the 4th worker's intentional denial.

## What the Demo Shows

Three workers are authorized and succeed:

| Worker | Tool | Action scope | Decision |
|---|---|---|---|
| incidents-reader | `demo:ops:incidents:read` | `action:ops-api:incidents:read` | ALLOW |
| deployments-reader | `demo:ops:deployments:read` | `action:ops-api:deployments:read` | ALLOW |
| logs-reader | `demo:ops:logs:read` | `action:ops-api:logs:read` | ALLOW |

One worker is denied:

| Worker | Tool | Requested action | Decision |
|---|---|---|---|
| denial-demo | `demo:ops:deployments:read` | `action:ops-api:incidents:read` | DENY |

The denial-demo worker holds a deployments mandate but requests an incidents action — a scope mismatch. Caracal denies the call before the handler runs.

## Enforcement Path

Every tool call goes through:

1. `MCPAdapterService` receives the request
2. `AuthorityEvaluator` validates the active mandate scope against the requested action and resource
3. Decision written to the Authority Ledger (ALLOW or DENY with reason code)
4. DENY → 403 response; result classified as `enforcement_deny` in traces

## Mock vs Real Mode

The enforcement path is identical in both modes. The only difference is the transport layer:

- **mock**: handlers return deterministic responses via `MockTransport`
- **real**: handlers proxy to `OPS_API_URL`

Authority evaluation runs in-process against the same database in both modes.

