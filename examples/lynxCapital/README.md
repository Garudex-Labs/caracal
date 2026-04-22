# Lynx Capital

Autonomous financial execution demo built on FastAPI, LangGraph, and Caracal.

## Requirements

- Python 3.11+
- An OpenAI API key

## Install

```
cd examples/lynxCapital
pip install -e .
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | yes | OpenAI key for LLM-backed agents |
| `CARACAL_API_KEY` | Phase 2 | Caracal workspace API key |
| `CARACAL_API_URL` | Phase 2 | Caracal API base URL |
| `CARACAL_WORKSPACE_ID` | Phase 2 | Active Caracal workspace id |

Copy `.env.example` to `.env` and fill in the values.

## Run

After `pip install -e .`, verify Caracal is available:

```
caracal --help
```

Then start the server:

```
uvicorn app.main:app --reload
```

Open `http://localhost:8000`.

## Routes

| Route | Description |
|---|---|
| `GET /` | Landing - scenario summary, disclaimer, Continue |
| `GET /demo` | Demo run - chat panel + live graph |
| `GET /logs` | Categorized runtime activity log |
| `GET /observe` | Per-run lineage and audit records |
| `GET /setup` | Caracal CLI guided setup (Phase 2) |

## Configuration

All company-specific values live in `config/company.yaml`. Edit that
file to adjust regions, providers, agent layer counts, theme colors,
and scenario copy without touching any Python or template files.
