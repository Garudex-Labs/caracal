# providerPreflight

## Scope
- Covers the automatable provider preflight that validates control-plane and
  Gateway readiness, dependency resolution (resource, provider, application),
  provider configuration, scope coverage, reachability, runtime-injection
  eligibility, and policy authorization before the first Gateway request.

## Architecture Design
- `preflight.mjs` holds pure, phased check functions and an orchestrator that
  takes injected readiness probes, fetched control-plane state, a DNS resolver,
  and an origin probe; every check result carries a phase, status, detail, and
  remediation.
- `run.mjs` wires the Caracal Admin API, Gateway `/ready` probe, DNS, and TCP
  probes into the orchestrator, builds the same OPA input shape STS uses for a
  real token exchange, and renders a phased human report or JSON.

## Required
- Must use only the public Admin API surface and the Node standard library.
- Must keep check functions pure and tested offline with injected dependencies.
- Must fail closed: any failed check exits non-zero.

## Forbidden
- Must not import Caracal repository internals or call live third-party services
  from tests.
- Must not embed admin tokens, secrets, or real endpoints.

## Validation
- Run `node --test` from this directory.
