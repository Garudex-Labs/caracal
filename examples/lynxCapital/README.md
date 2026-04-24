# Lynx Capital

Autonomous financial execution demo built on FastAPI, LangGraph, and Caracal.

## Requirements

- Python 3.11+
- An OpenAI API key
- Docker (for the Caracal runtime)
- `caracal-core` and `caracal-sdk` installed (`pip install caracal-core caracal-sdk`)

## Install

```
cd examples/lynxCapital
pip install -e .
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | yes | OpenAI key for LLM-backed agents |
| `CARACAL_API_KEY` | yes | Caracal workspace API key |
| `CARACAL_API_URL` | yes | Caracal API base URL |
| `CARACAL_WORKSPACE_ID` | yes | Active Caracal workspace id |

Copy `.env.example` to `.env` and fill in the values.

## Demo run-through

### 1. Install

```
cd examples/lynxCapital
pip install -e .
```

### 2. Set environment variables

```
cp .env.example .env
# edit .env: fill in OPENAI_API_KEY, CARACAL_API_KEY, CARACAL_API_URL, CARACAL_WORKSPACE_ID
```

### 3. Install Caracal CLI and start the runtime

```
pip install caracal-core caracal-sdk
caracal up
caracal migrate
caracal bootstrap
```

`caracal bootstrap` provisions the system principal, issues the AIS attestation nonce, and mints a local `CARACAL_API_KEY`. All values are stored internally in `$CARACAL_HOME/runtime/.env`; you only need the API key.

### 4. Configure Caracal workspace

Open `http://localhost:8000/setup` and run the commands listed there in order:

1. Create the workspace
2. Register all 9 principals (one per agent layer)
3. Register all 11 providers
4. Create policies (finance-control full access, policy-check read-only, payment-execution narrow scope)
5. Issue the top-level mandate and delegate to regional orchestrators

Then paste the SDK API key into `examples/lynxCapital/.env`:

```
caracal auth token --quiet
```

Copy the printed value into `CARACAL_API_KEY=` in `.env`. `CARACAL_WORKSPACE_ID=lynx-capital` is preset.

Click **Validate configuration** to confirm all steps pass before continuing.

### 5. Start the app

```
cd examples/lynxCapital
Upgrade payment providers to scoped mode so tools can be registered against them.
# Mercury Bank — add scoped catalog (payment resource + actions)
provider update mercury-bank --mode scoped --resource "payment=Payment account management" --action "payment:get_account_balance:GET:/v1/balance" --action "payment:submit_payment:POST:/v1/payments"copy
# Wise Payouts — add scoped catalog (payout resource + actions)
provider update wise-payouts --mode scoped --resource "payout=Cross-border payout transfers" --action "payout:get_quote:GET:/v1/quotes" --action "payout:submit_payout:POST:/v1/payouts"copy
Register tools so mandates in Phase 6 can reference them. Click Fill UUIDs after Phase 3 first so <finance-control-uuid> is substituted.
# Mercury Bank payment tool — used as the root mandate tool
tool register --tool-id "provider:mercury-bank:resource:payment:action:submit_payment" --provider-name mercury-bank --resource-id payment --action-id submit_payment --actor-principal-id <finance-control-uuid>copy
# Wise Payouts payout tool — used as the payment mandate tool
tool register --tool-id "provider:wise-payouts:resource:payout:action:submit_payout" --provider-name wise-payouts --resource-id payout --action-id submit_payout --actor-principal-id <finance-control-uuid>```

Open `http://localhost:8000`.

### 6. Run the demo

1. Navigate to `http://localhost:8000` — review the scenario summary and accept the disclaimer.
2. Go to `/demo` — enter a prompt or use the default and click **Send**.
3. Watch the chat panel stream agent turns and the graph panel build the topology live.
4. Use **Pause** to freeze the display; use **Cancel** to terminate the run mid-execution.
5. After the run completes, the run ID is stored in `localStorage`.

### 7. Review logs

Go to `/logs`. Use category chips to filter by `caracal`, `agent`, `tool`, `service`, `audit`.
Click any line to expand the raw JSON payload. Pause/Resume and Clear work live.

### 8. Review lineage

Go to `/observe`. Paste the run ID from the demo (visible in the chat panel on completion).
Click **Load** to render the full agent lineage tree with:
- Bound principal and mandate per agent
- Enforcement decision (allow / deny) per tool call
- Final lifecycle status per agent

## Routes

| Route | Description |
|---|---|
| `GET /` | Landing — scenario summary, disclaimer, Continue |
| `GET /demo` | Demo run — chat panel + live graph |
| `GET /logs` | Categorized runtime activity log |
| `GET /observe` | Per-run lineage and audit records |
| `GET /setup` | Caracal CLI guided setup |

## Configuration

All company-specific values live in `config/company.yaml`. Edit that
file to adjust regions, providers, agent layer counts, theme colors,
and scenario copy without touching any Python or template files.
