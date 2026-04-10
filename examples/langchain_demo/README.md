# Caracal LangChain Demo

This example now has one real Caracal-backed app surface inside the existing demo package:
- `app.py`: local FastAPI UI for mock and real governed runs
- `caracal/`: governed workflow entrypoints and local logic handlers
- `baseline/`: plain LangChain comparison track
- `bootstrap/`: external-runtime bootstrap flow for fuller broker-mode setups

## Quick Start

Install demo dependencies:

```bash
python -m pip install -r examples/langchain_demo/requirements.txt
```

Run the local UI:

```bash
python -m examples.langchain_demo.app
```

Then open `http://127.0.0.1:8090`.

## Caracal App Modes

Mock mode:
- upstream provider responses are simulated
- Caracal itself is still real and active
- the run still exercises SDK calls, MCP routing, provider mapping, mandate checks, delegation, metering, and revocation

Real mode:
- the same governed flow runs against real providers
- set `OPENAI_API_KEY` for OpenAI-backed routes
- set `GOOGLE_API_KEY` or `GEMINI_API_KEY` for Gemini-backed routes

Run one governed artifact without starting the UI:

```bash
python -m examples.langchain_demo.app --run-once --mode mock --provider-strategy mixed
```

## Governed CLI

Mock governed run:

```bash
python -m examples.langchain_demo.caracal.main --mode mock --provider-strategy mixed
```

Real governed run:

```bash
OPENAI_API_KEY=... \
GOOGLE_API_KEY=... \
python -m examples.langchain_demo.caracal.main --mode real --provider-strategy mixed
```

Default governed artifact:
- `examples/langchain_demo/caracal/outputs/latest.json`

## Baseline CLI

Deterministic baseline mode:

```bash
python -m examples.langchain_demo.baseline.main --mock always
```

OpenAI-backed baseline mode:

```bash
OPENAI_API_KEY=... python -m examples.langchain_demo.baseline.main --provider openai --mock auto
```

Gemini-backed baseline mode:

```bash
GOOGLE_API_KEY=... python -m examples.langchain_demo.baseline.main --provider gemini --mock auto
```

## Bootstrap

Dry-run:

```bash
python -m examples.langchain_demo.bootstrap.main
```

Apply:

```bash
python -m examples.langchain_demo.bootstrap.main --apply
```

## Comparison

Run both mock tracks and write the comparison artifact:

```bash
python -m examples.langchain_demo.compare_tracks
```

This writes `examples/langchain_demo/outputs/comparison.json`.
