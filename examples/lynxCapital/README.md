# Lynx Capital

Autonomous financial execution layer demo. A FastAPI + LangGraph swarm that
processes a global SaaS payout cycle (~4,200 invoices, 5 regions) end-to-end
with a live agent topology view and SSE log stream.

## Requirements

- Python 3.14+
- Docker
- An OpenAI API key

## Quick start

### 1 — Install dependencies

```bash
cd caracal/examples/lynxCapital
python -m venv .venv && source .venv/bin/activate

pip install -e .
pip install \
  -e _mock/sdk/lynx_sdk_stripe_treasury \
  -e _mock/sdk/lynx_sdk_tax
```

The `caracalai-sdk>=0.1.1` pin lives in `pyproject.toml`.

### 2 — Configure environment

```bash
cp .env.example .env
```

Open `.env` and set `OPENAI_API_KEY=sk-...`. Everything else has working
defaults for the local mock network.

### 3 — Start the mock provider network

The mock network simulates all 11 external financial services (banking, ERP,
OCR, FX, compliance, vendor portal, tax) across REST, SSE, gRPC, and MCP.
The image is built locally — it is not published to any registry.

```bash
docker compose -f _mock/docker-compose.yml up -d --build --wait
```

To re-check status later:

```bash
docker compose -f _mock/docker-compose.yml ps -a
```

### 4 — Start Caracal

Caracal (Coordinator + Gateway + STS + Redis) must be running before Lynx
starts. Install the latest CLI (`v2026.05.14` channel) and bring up the
stack the same way any end user would — **do not build from the caracal
source tree**:

```bash
# Install the CLI and TUI once (no sudo, lands in ~/.local/bin)
curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install-cli.sh | sh
curl -fsSL https://raw.githubusercontent.com/Garudex-Labs/caracal/main/install-tui.sh | sh

# Bring up the OSS stack (coordinator, gateway, STS, postgres, redis, ...)
caracal up

# Provision a zone + application. `caracal zone create` returns the zone id;
# `caracal app create` returns the client secret. Author
# ~/.config/caracal/caracal.toml with the returned zone_id / application_id /
# app_client_secret. Lynx reads the file at startup and exchanges the
# client_secret for a real STS access token.
caracal zone create --name lynx
caracal app  create --zone <id> --name lynx

# Register every external provider as a Caracal resource so the gateway
# knows where to forward calls. The mock REST aggregator hosts all 13
# providers behind a single prefix.
for p in mercury-bank wise-payouts stripe-treasury netsuite sap-erp \
         ocr-vision close-engine regulatory-filings customer-billing \
         compliance-nexus treasury-ops; do
  caracal resource add "lynx/${p}" --upstream "http://${p}.mock"
done

# Inspect live agent sessions, tickets, and delegation tree
caracal-tui
```

The stack listens on:

- API         → `http://localhost:3000`
- Coordinator → `http://localhost:4000`
- Gateway     → `http://localhost:8081`
- STS         → `http://localhost:8080`

The defaults in `.env.example` already point at these. If you run Caracal on
different hosts/ports, edit the `CARACAL_*` block in your `.env`.

> The Caracal CLI is the *only* end-user surface. If you already had the
> Caracal monorepo cloned and used `pnpm i -g` from it, remove the stale
> workspace shim first so the released binary wins:
> `rm "$(pnpm bin -g)/caracal" 2>/dev/null || true`.

### 5 — Run Lynx Capital

Pick one path:

```bash
# Local Python (development)
python -m uvicorn app.main:app --reload --port 8000

# Container (production-like — joins the mock and caracal networks)
docker compose up -d --build
```

Open **http://localhost:8000**.

## Routes

| Path | Description |
|---|---|
| `/` | Landing — scenario summary |
| `/setup` | Validates `OPENAI_API_KEY` and Caracal connectivity |
| `/demo` | Chat interface + live agent topology graph |
| `/logs` | Color-coded runtime activity stream |
| `/prompts` | Example prompts grouped by execution pattern |

## Example prompts

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
caracal purge --include-destructive all
```

## Layout

```
app/             FastAPI app (api, web, agents, orchestration, services, events, core)
config/          company.yaml (copy, regions, providers, swarm caps, theme)
_mock/           Deterministic mock provider network (local only — not published)
tests/           Topology, lifecycle, and mock determinism tests
INSTRUCTIONS.md  Build rules
```
