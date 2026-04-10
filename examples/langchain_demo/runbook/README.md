# Runbook

This demo supports two practical local paths:
- lightweight local app mode through `examples.langchain_demo.app`
- fuller broker-mode setup through `examples.langchain_demo.bootstrap.main`

## Local App

Install dependencies:

```bash
python -m pip install -r examples/langchain_demo/requirements.txt
```

Serve the UI:

```bash
python -m examples.langchain_demo.app
```

Open `http://127.0.0.1:8090` and run:
- `mock` mode for deterministic provider simulation through real Caracal routing
- `real` mode for actual provider calls through the same governed workflow

One-shot governed artifact:

```bash
python -m examples.langchain_demo.app --run-once --mode mock --provider-strategy mixed
```

## Governed CLI

Mock:

```bash
python -m examples.langchain_demo.caracal.main --mode mock --provider-strategy mixed
```

Real mixed routing:

```bash
OPENAI_API_KEY=... \
GOOGLE_API_KEY=... \
python -m examples.langchain_demo.caracal.main --mode real --provider-strategy mixed
```

Real OpenAI-only routing:

```bash
OPENAI_API_KEY=... \
python -m examples.langchain_demo.caracal.main --mode real --provider-strategy openai
```

Real Gemini-only routing:

```bash
GOOGLE_API_KEY=... \
python -m examples.langchain_demo.caracal.main --mode real --provider-strategy gemini
```

## Baseline CLI

```bash
python -m examples.langchain_demo.baseline.main --mock always
```

## Broker Mode

Dry-run bootstrap:

```bash
python -m examples.langchain_demo.bootstrap.main
```

Apply bootstrap:

```bash
python -m examples.langchain_demo.bootstrap.main --apply
```

## What To Inspect

- `caracal/outputs/latest.json`
- `baseline/outputs/latest.json`
- `outputs/comparison.json`
- runtime logs in the terminal while the app runs

The governed artifact includes:
- role identities
- delegation edges
- authority validations
- metering events
- upstream provider requests
- revocation denial evidence
