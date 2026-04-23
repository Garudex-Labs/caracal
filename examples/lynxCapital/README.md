# Lynx Capital

Autonomous financial execution demo built on FastAPI, LangGraph, and Caracal.

## Requirements

- Python 3.11+
- An OpenAI API key
- Caracal runtime (see `/setup` for CLI commands)

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

### 3. Start the Caracal runtime

```
caracal up
caracal migrate
```

### 4. Configure Caracal workspace

Open `http://localhost:8000/setup` and run the commands listed there in order:

1. Create the workspace and issue an API key
2. Register all 9 principals (one per agent layer)
3. Register all 11 providers
4. Create policies (finance-control full access, policy-check read-only, payment-execution narrow scope)
5. Issue the top-level mandate and delegate to regional orchestrators

Click **Validate configuration** to confirm all steps pass before continuing.

### 5. Start the app

```
cd examples/lynxCapital
uvicorn app.main:app --reload
```

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
