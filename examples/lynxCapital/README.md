# Lynx Capital

A production-grade reference for running a SaaS platform on Caracal the way Caracal is meant
to be used. Lynx Capital is a wealth-management platform that serves many customer firms.
Each customer runs Portfolio, Research, and Compliance agents over shared domain services,
and every customer is isolated from every other by its subject identity and the policy set.

This example is the primary reference implementation for modelling customers, one managed
application per service, least-privilege agents, resources, policies, and the SDK flows that
tie them together.

## Architecture

```
Lynx Capital platform (one zone)
│
├── service applications (managed)     one application = one trust boundary per service
│     ├── lynx-portfolio   → resource://portfolio    portfolio:read|write|admin   (pf-mandate)
│     ├── lynx-research    → resource://research      research:read|write          (rs-mandate)
│     └── lynx-compliance  → resource://compliance    compliance:review|admin      (cp-mandate)
│           └── agent sessions   spawned per customer + role, least-privilege, metadata={customer_id}
│
├── policy set "lynx-platform"   00-base + 11 scenario policies (policies/)
│
└── customers (subjects)
      ├── aurora    customer:aurora    plan=enterprise
      └── borealis  customer:borealis  plan=growth
```

The single source of truth for this model is [`config/tenancy.yaml`](config/tenancy.yaml);
the capability-to-scope mapping lives in [`policies/manifest.json`](policies/manifest.json).

### One zone, one application per service, customers as subjects

Caracal multi-tenancy does **not** mean one application per customer. It means one zone with
**one managed application per domain service** — its own trust boundary that can reach only
its own resource — and **each customer modelled as a subject**. Every customer agent is an
agent session spawned under the relevant service application (`lynx-portfolio`,
`lynx-research`, or `lynx-compliance`), correlated to the customer through the subject (and
`spawn` metadata) and narrowed to that application's resource scopes. A portfolio agent can
therefore never obtain research or compliance authority, even when its role is cross-domain,
and every customer/role gets its own least-privilege session and audit trail.

Dynamic Client Registration (DCR) is deliberately **not** used here. DCR is for
externally-launched, isolated, auto-expiring identities that bind to a single agent session —
not for an operator fanning out its own in-process agents. Using customers-as-subjects is the
correct, simpler model and is what Caracal optimises for.

### Customer isolation

- **Subject** — each customer is a stable subject; an agent only ever acts for the customer
  it was spawned for, and the upstream serves only that subject's data. Isolation is
  structural, not a forgeable label.
- **Policy** — [`policies/00-base.rego`](policies/00-base.rego) is default-deny, denies any
  customer-scoped request that carries no customer subject, and gates premium capabilities on
  the customer's `plan` claim, so the same role yields different authority per customer.
- **Least privilege** — every agent is spawned with `Grant.narrow(...)` over the role's
  scopes, capped to one delegation hop, a short TTL, and an explicit call budget. Effective
  authority is the intersection of policy, grant, resource, and delegation.

## Quick start (full platform)

### 1. Install

```bash
cd caracal/examples/lynxCapital
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -e ".[dev]"
```

### 2. Configure the workload environment

```bash
cp -n .env.example .env
```

The workload `.env` holds only the Caracal variables the application reads at runtime.
Prefer a Console-generated `caracal.toml` profile (`CARACAL_CONFIG`); otherwise set the
zone, this service's managed application credential, and `CARACAL_RESOURCES`. See
[Environment model](#environment-model).

### 3. Provision the platform

Provisioning is driven by a **scoped Control key** created once in Console, sourced from a
separate operator file so its credentials never mix with the workload `.env`:

```bash
cp -n .env.provision.example .env.provision   # fill in CONTROL_CLIENT_ID / _SECRET
. .env.provision
python scripts/provision.py
```

It reads `config/tenancy.yaml` + `policies/` and idempotently creates the managed
applications, registers the credential providers and the three resources (each bound to its
application), authors the policy library, and activates the `lynx-platform` policy set. Tear
down with `python scripts/teardown.py`. The managed applications are normally created once in
Console (each secret is shown once); provisioning never handles runtime secrets or grants —
the policy set is the day-to-day authorization knob.

### 4. Run the SDK reference

```bash
python scripts/reference.py
```

[`scripts/reference.py`](scripts/reference.py) is the canonical SDK walkthrough: it prints
the full application/customer/agent/scope plan offline, and when Caracal is configured it
connects as a service application, spawns each customer's role agents with narrowed grants,
exercises gateway resource authorization with `fetch()`, and demonstrates delegated
least-privilege fan-out — with redacted secrets and fail-closed error handling.

## When to use what

- **Onboard a customer**: add a customer block to `config/tenancy.yaml` (id, name, subject,
  plan). No new application, grant, or DCR registration is needed — each service application
  spawns its agents for the new subject against the existing policy set.
- **Add a capability/policy**: drop a `*.rego` into `policies/`, register it in
  `policies/manifest.json` (capability → resource → grants) and map it to a role. Re-run
  provisioning to author and activate the new policy-set version.
- **Add a service**: add an application block to `config/tenancy.yaml` with its provider,
  resource (scopes + `upstreamEnv`), and agents, then point that env var at the upstream per
  environment.

## Policy library

[`policies/`](policies/) is an importable, OPA-tested library. `00-base.rego` provides the
default-deny decision contract and per-customer subject scoping; eleven scenario policies
(`portfolio-read/write/admin`, `research-read/write`, `compliance-review/admin`,
`customer-admin`, `auditor`, `delegated-advisor`, `emergency-access`) each contribute the
scopes their capability allows. Full documentation, expected access behavior, and testing
instructions are in [`policies/README.md`](policies/README.md).

```bash
opa test policies/ -v
```

## SDK integration

Application code uses one seam, [`app/caracal.py`](app/caracal.py):

```python
from app import caracal

# Spawn one customer's role agent under its service application: capability labels, the
# customer in metadata, and a delegation edge narrowed to that application's resource scopes.
async with caracal.spawn_customer_agent("aurora", "portfolio", application_id="portfolio") as ctx:
    response = await caracal.fetch("portfolio", "/api/read", method="GET")
```

`spawn_customer_agent` derives labels and scopes from `config/tenancy.yaml` +
`policies/manifest.json` via [`app/tenancy.py`](app/tenancy.py), so the SDK, provisioning, and
policy all stay consistent with a single model. The client itself is built with
`Caracal.connect()`, which resolves the zone, credential, resources, and every service URL
from the Console profile or the workload environment — the application hardcodes no endpoints.

## Environment model

The workload application reads only Caracal variables; the operator provisioning script reads
only its own. The two never mix.

**Workload (`.env`)**

| Variable | Purpose |
| --- | --- |
| `CARACAL_CONFIG` | Path to the Console `caracal.toml` profile (preferred; resolves everything below). |
| `CARACAL_ZONE_ID` | The platform's isolation boundary (fallback when no profile). |
| `CARACAL_APPLICATION_ID` / `CARACAL_APP_CLIENT_SECRET[_FILE]` | This service's managed application credential (one per service process). |
| `CARACAL_RESOURCES` | `slug=upstream` pairs for the resources the app may route to. |
| `CARACAL_STS_URL` / `CARACAL_GATEWAY_URL` / `CARACAL_COORDINATOR_URL` | Optional service overrides. |
| `OPENAI_API_KEY` | Model provider key. |
| `LYNX_SIMULATION` | Offline demo only — serve the simulated providers directly. Provider access otherwise fails closed without Caracal. |

**Operator (`.env.provision`, sourced only when provisioning)**

| Variable | Purpose |
| --- | --- |
| `CONTROL_CLIENT_ID` / `CONTROL_CLIENT_SECRET` | The scoped Control key issued by Console. |
| `STS_URL` / `CONTROL_URL` / `CONTROL_AUDIENCE` / `CONTROL_SCOPES` / `CONTROL_TTL_SECONDS` | Optional Control overrides. |
| `LYNX_RESOURCE_PORTFOLIO_URL` / `_RESEARCH_URL` / `_COMPLIANCE_URL` | Resource upstreams registered at provisioning time. |

## Testing

```bash
opa test policies/ -v                       # 20 policy decision tests
python -m pytest tests/test_policy_library.py tests/test_tenancy_plan.py -q
python -m pytest -q                          # full example suite
```

The identity-layer tests cover the policy decision suite, the provisioning-plan builders
(provider/resource/policy commands), and the setup surface. They run offline — no live
control plane required.

## Production-readiness review

- **Security / authorization boundaries** — default-deny base policy; every requested scope
  must be explicitly contributed by a loaded capability. No allow-all baseline.
- **Customer isolation** — each customer is a subject; agents only act for the customer they
  were spawned for, and the base policy denies customer-scoped requests with no subject.
- **Privilege escalation** — agents are spawned with `Grant.narrow` over the role's scopes,
  capped to one hop, a short TTL, and a call budget; `emergency-access` requires a resolved
  step-up; `delegated-advisor` intersects with the delegation edge's scopes; admin and
  break-glass capabilities require a premium plan.
- **Secret management** — the workload reads its credential from a profile or
  `CARACAL_APP_CLIENT_SECRET_FILE`; the gateway holds upstream provider credentials so
  application code never sees them; the SDK reference redacts tokens.
- **Least authority** — provisioning uses a scoped, short-TTL, zone-bound Control key with no
  runtime data authority; there is no admin token in the workload.
- **SDK ergonomics** — a single `app/caracal.py` seam built on `Caracal.connect()`;
  model-driven labels/scopes keep the SDK, provisioning, and policy in lock-step.
- **Maintainability** — onboarding a customer or capability is a config/manifest edit; no code
  changes.

---

## Bundled demo workload (optional)

The repository also ships a FastAPI + LangGraph swarm that processes a simulated global payout
cycle against a local mock provider network under `_mock/`. It is an optional workload for
exercising the runtime and is independent of the identity model above.

```bash
docker compose -f _mock/docker-compose.yml up -d --build --wait   # start mock providers
python -m uvicorn app.main:app --reload --port 8000               # run the app
docker compose -f _mock/docker-compose.yml down                   # tear down
```

Open `http://localhost:8000`; the landing page leads through the overview pages before the
guided `/setup` wizard, which teaches the one-zone, managed-application, policy-library, and
customers-as-subjects flow described here.
