# Caracal Track

This track is now a real Caracal-backed application workflow, not just a static artifact generator.

Key pieces:
- `main.py`: governed CLI entrypoint
- `workflow.py`: wrapper around the shared in-process Caracal runtime
- `runtime_bridge.py`: local logic handlers used by Caracal `handler_ref` execution
- `../app.py`: FastAPI UI for visual local runs

## Mock Mode

```bash
python -m examples.langchain_demo.caracal.main --mode mock --provider-strategy mixed
```

## Real Mode

OpenAI only:

```bash
OPENAI_API_KEY=... \
python -m examples.langchain_demo.caracal.main --mode real --provider-strategy openai
```

Gemini only:

```bash
GOOGLE_API_KEY=... \
python -m examples.langchain_demo.caracal.main --mode real --provider-strategy gemini
```

Mixed routing:

```bash
OPENAI_API_KEY=... \
GOOGLE_API_KEY=... \
python -m examples.langchain_demo.caracal.main --mode real --provider-strategy mixed
```

## What The Governed Flow Shows

- identity-bound callers for orchestrator, finance, and ops
- delegated subset mandates per role
- provider mapping across internal data, OpenAI, Gemini, and local logic execution
- runtime enforcement on every tool call
- revocation with a denied follow-up finance call
- metering and authority evidence in the final artifact
