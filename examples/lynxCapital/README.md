# Lynx Capital

A production-grade reference for running an autonomous agent swarm on Caracal. Lynx Capital
is a finance-operations platform whose LLM swarm - orchestrators, regional workflows, and
thousands of ephemeral domain workers - executes payout cycles across twenty partner
providers, with every agent and every provider call governed by Caracal.

The model is one zone with **one managed application per permission boundary**
(`lynx-operations`, `lynx-intake`, `lynx-ledger`, `lynx-compliance`, `lynx-treasury`,
`lynx-payments`, `lynx-audit`). Every spawned agent runs as its own labeled Caracal agent
session under its role's application, narrowed by a delegation edge to its role's scopes;
every partner is a registered credential provider reached only through per-application
resource views at the Gateway. Workers acting on one customer's records spawn with a
`customer:<id>` label and a `customer_id` metadata key - the label is policy-enforced
(customer-labeled agents mint customer-record scopes only) and the metadata key makes
per-customer audit a direct filter over the shared zone trail. The single source of truth
is [`config/tenancy.yaml`](config/tenancy.yaml).

## 1. Install

```bash
cd examples/lynxCapital
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -e ".[dev]"
```

## 2. Run

`caracal up` needs the released Caracal CLI on your PATH. Install it first:

```bash
curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install.sh | \
  sh -s -- --version v2026.06.25-rc.1
```

```bash
caracal up                                                        # start the Caracal platform
docker compose -f _mock/docker-compose.yml up -d --build --wait   # start mock providers
python -m uvicorn app.main:app --reload --port 8000               # run the app
```


It must run before the mock providers: `caracal up` creates the `caracalData` Docker network
they join so mandate-aware providers can verify Caracal mandates against the zone JWKS.
The provider lab runs on this private Docker network; the Gateway reaches operator-provisioned
private upstreams by default, so no SSRF allowlist step is required.

`caracal up` also starts the **Caracal web console** - the operator UI for the control
plane - at `http://localhost:3001`. Use it to create the zone and a scoped Control key
(steps 3–4). The Lynx Capital app itself runs at `http://localhost:8000`.

## 3. Configure the workload

After the wizard, copy the values it shows into `.env`:

```bash
cp -n .env.example .env
```

`.env` holds only the Caracal variables the app reads at runtime: the zone and one
`LYNX_CARACAL_<APP>_APPLICATION_ID` / `_CLIENT_SECRET` pair per application boundary.
Without Caracal configured, provider access fails closed; set `LYNX_SIMULATION=1` only to
exercise the offline simulators.

## 4. Provision automatically

Create a **scoped Control key** in the Caracal web console, then replay the whole zone
setup from a script. Open the web console at `http://localhost:3001` (started by
`caracal up`) and go to **Control → New control key**: pick the scopes, max token TTL,
and expiry, and the console reveals the `client_id` and one-time `client_secret`. Save
them into `.env.provision`:

```bash
cp -n .env.provision.example .env.provision   # fill in CONTROL_CLIENT_ID / _SECRET
. .env.provision
python scripts/provision.py                   # python scripts/teardown.py to undo
```

It reads `config/tenancy.yaml` + `policies/` and idempotently creates the seven managed
applications, registers the twenty credential providers in their exact provider-kind
config shapes, creates the per-application resource views, renders the application-id
bindings into the policy library, and activates the `lynx-finance-ops` policy set. It
writes the per-application credential exports to `config/provisioned.env` for the workload
`.env`; each client secret is returned exactly once. The Control key has no runtime data
authority.

It also prints the `LYNX_CARACAL_PARTNERSHIP` export: the partnership terms (accepted
resource-view audiences and Caracal scope-to-operation grants) the mandate-verifying
mock providers are configured with. Export it before starting the provider lab -
without it those providers fail closed on Caracal-issued mandates.

## 5. Run the SDK reference

```bash
python scripts/reference.py
```

[`scripts/reference.py`](scripts/reference.py) is the canonical SDK walkthrough: it prints
the application/role/scope/view plan offline, and when Caracal is configured spawns one
labeled worker session per boundary with a narrowed grant and mints a resource mandate
under policy.

Application code uses two seams: [`app/caracal.py`](app/caracal.py) (per-application
runtimes, worker authority, mandate minting, gateway calls) and
[`app/agents/runner.py`](app/agents/runner.py) (per-agent session lifecycle):

```python
handle = await runner.aspawn("payment-execution", "payments.us", parent=fc, layer="worker")
result = partners.call("meridian-pay", "create_payout", payload, authority=handle.authority)
```

## 6. Test

```bash
opa test policies/ ../../services/sts/internal/decision_contract.rego -v   # policy decision tests
python -m pytest -q                          # full example suite
```

Full policy documentation and expected access behavior are in
[`policies/README.md`](policies/README.md).
