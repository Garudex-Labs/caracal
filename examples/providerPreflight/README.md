# Provider Preflight

A pre-launch checklist for a provider-backed resource. One command checks that
everything a Gateway request depends on — control plane, Gateway, application,
provider, upstream, and policy — is actually ready, and prints a fix for
anything that is not.

Without it, a broken link in that chain shows up as an opaque `401`/`502` on
the first production request. Run the preflight after provisioning a resource
and from CI before each deploy.

## Try it

```bash
cd examples/providerPreflight

# Zero setup — offline tests show every check pass and fail:
node --test

# Against your deployment:
CARACAL_API_URL=http://127.0.0.1:3000 \
CARACAL_ADMIN_TOKEN=<admin-token> \
PREFLIGHT_ZONE_ID=<zone-id> \
PREFLIGHT_RESOURCE_ID=<resource-id> \
PREFLIGHT_APPLICATION_ID=<app-id> \
PREFLIGHT_SCOPES=pipernet:read \
node run.mjs
```

No zone yet? Bootstrap one with `examples/controlBootstrap` first.

## What it checks

| Phase | Validates |
| --- | --- |
| readiness | Admin API and Gateway report ready (Gateway ready covers Postgres, Redis, STS, revocations, audit). |
| dependencies | The resource is bound to a provider and application, and the application exists and is not expired. |
| configuration | Provider config is complete for its kind, requested scopes are declared on the resource, runtime injection is allowed when required. |
| connectivity | OAuth token endpoint, callback origin, and upstream are HTTPS/public/reachable. |
| authorization | The active policy set returns `allow` for this application, resource, and scopes — simulated with the same input a real token exchange uses. |

## Output

```text
== readiness ==
[PASS] admin API readiness: Admin API reports ready
[FAIL] gateway readiness: GET /ready returned 503 (reason: sts_unreachable)
       fix: Gateway cannot reach STS; token exchange will fail. Check STS health and network path.
...
9/11 ok, 1 warn, 1 fail
Preflight failed: resolve the FAIL items above before sending Gateway traffic.
```

Every `FAIL`/`WARN` includes a `fix:` line. Exit codes: `0` ready, `1` a check
failed, `2` the preflight itself could not run.

## Options

- `PREFLIGHT_GATEWAY_URL` — also probe the Gateway's `/ready` endpoint.
- `PREFLIGHT_REQUIRE_RUNTIME_INJECTION=true` — require runtime-injection eligibility.
- `PREFLIGHT_OUTPUT=json` — JSON report for CI.

Note: reachability checks probe from the host running the script; run from a
network position comparable to the Gateway for meaningful results.
