# Lynx Capital

Autonomous financial execution reference lab. A FastAPI + LangGraph swarm that
processes a global SaaS payout cycle (~4,200 invoices, 5 regions) end-to-end
with a live agent topology view and SSE log stream.

Canonical walkthrough: https://caracal.run/examples/lynx-capital/

## Requirements

- Python 3.14+
- Docker
- An OpenAI API key

## Quick start

### 1: Install dependencies

```bash
cd caracal/examples/lynxCapital
python -m venv .venv && source .venv/bin/activate

pip install -e .
pip install \
  -e _mock/sdk/lynx_sdk_stripe_treasury \
  -e _mock/sdk/lynx_sdk_tax
```

The `caracalai-sdk==0.1.3rc1` pin lives in `pyproject.toml`.

### 2: Configure environment

```bash
cp .env.example .env
```

Open `.env` and set `OPENAI_API_KEY=sk-...`. Provider credentials are normal
integration settings; Caracal credentials come from `caracal.toml`.

### 3: Start Caracal through Console + control API

Caracal (API + Coordinator + Gateway + STS + Redis) must be running before
Lynx starts. Install the released runtime/console and bring up the stack the same way
an end user would: **do not build from the caracal source tree**:

```bash
# Install the runtime shell and Console once (no sudo, lands in ~/.local/bin)
curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install-console.sh | sh

# Bring up the OSS stack
caracal up
caracal status --ready

# Open the Console. Use it to inspect/create:
#   1. control endpoint: enable from the Control menu
#   2. zone: Lynx Capital
#   3. control key: lynx-control (copy client_secret once)
#   4. resources: lynx/<provider> for every provider in config/company.yaml
caracal-console
```

The Console talks to the same control plane as the Control API. The control key is a real
Caracal application credential with the `control:invoke` trait; Lynx stores
its `client_id` as `application_id` and its one-time `client_secret` as
an owner-only secret file referenced by `caracal.toml`.

### 4: Create the runtime profile from Console values

After creating the Lynx zone, control key, and resources in the Console, use
the Console-generated runtime profile contract. Enable **write files** when you
want the Console to create the profile and one-time secret file locally. If you
write files through platform automation, store the control key secret at the
local auto-detected runtime path. Cloud deployments and custom secret stores use
the runtime configuration docs for explicit secret-file paths. The Python SDK
reads this profile directly, so Caracal credentials stay out of `.env`.

```toml
[[credentials]]
env = "LYNX_MERCURY_BANK_TOKEN"
resource = "lynx/mercury-bank"
upstream_prefix = "http://127.0.0.1:8800"
```

Repeat `[[credentials]]` for every `lynx/<provider>` resource in
`config/company.yaml`. REST provider bindings use
`upstream_prefix = "http://127.0.0.1:8800"` for local Python runs; direct
protocol providers use their own local endpoints, such as
`http://127.0.0.1:50051` for `lynx/treasury-ops` and
`http://127.0.0.1:7800` for `lynx/vendor-portal`.

The SDKs and generated profiles use the local Caracal endpoints automatically.
Cloud deployments and custom service locations use the runtime configuration docs
for explicit service URL overrides.

> If you already had the Caracal monorepo cloned and used `pnpm i -g` from it,
> remove the stale workspace shim first so the released binary wins:
> `rm "$(pnpm bin -g)/caracal" 2>/dev/null || true`.

### 5: Start the local provider network

The local provider network lives under `_mock/` and supplies deterministic
reference-lab provider fixtures across REST, SSE, gRPC, and MCP. The Lynx app
still calls providers through its registry and transport clients, and the image
joins `caracalData` so the Caracal Gateway can forward to REST providers by
resource.

```bash
docker compose -f _mock/docker-compose.yml up -d --build --wait
```

To re-check status later:

```bash
docker compose -f _mock/docker-compose.yml ps -a
```

### 6: Run Lynx Capital

Pick one path:

```bash
# Local Python (development)
python -m uvicorn app.main:app --reload --port 8000

# Container (production-like: joins the provider and caracalData networks)
docker compose up -d --build
```

Open **http://localhost:8000**.

## Run flow

1. Open `caracal-console` and verify the Lynx zone,
   control key, resources, live agent sessions, tickets, and delegation tree.
2. Open `http://localhost:8000/setup`, follow the Console and `caracal.toml`
   checklist, then validate.
3. Open `/demo` and submit a prompt. The browser uses the Lynx control API:
   `POST /api/run/start`, `GET /api/run/{runId}/events`,
   `GET /api/run/{runId}/status`, `POST /api/run/{runId}/cancel`, and
   `GET /api/run/{runId}/lineage`.
4. Keep the Console open while the run executes to inspect Caracal sessions and
   delegated child agents in the real control plane.

## Routes

| Path | Description |
|---|---|
| `/` | Landing: scenario summary |
| `/setup` | Validates `OPENAI_API_KEY` and Caracal connectivity |
| `/demo` | Chat interface + live agent topology graph |
| `/logs` | Color-coded runtime activity stream |
| `/prompts` | Example prompts grouped by execution pattern |

## Reference prompts

The `/prompts` page lists ready-to-run prompts. A few to start with:

- *"Run the full global payout cycle for this month."*
- *"Process all US region vendor invoices and submit to QuickBooks."*
- *"Run treasury close for Q2 and file compliance reports for DE and SG."*
- *"Audit all open receivables and flag overdue accounts."*

## Tests

```bash
pytest tests/
```

## Tear down

```bash
docker compose -f _mock/docker-compose.yml down
caracal down
# or, for a full reset (containers + volumes + caracal.toml):
caracal purge all
```

## Layout

```
app/             FastAPI app (api, web, agents, orchestration, services, events, core)
config/          company.yaml (copy, regions, providers, swarm caps, theme)
_mock/           Local provider fixtures (not published)
tests/           Topology, lifecycle, and provider transport tests
INSTRUCTIONS.md  Build rules
```
