# Caracal Track

This track runs against your real Caracal workspace configuration.

Core points:

- no in-process authority simulation
- no automatic workspace/provider/tool/mandate bootstrap in runtime code
- same governed execution flow in mock and real modes
- mock mode only changes external provider responses to deterministic payloads
- SDK calls are execution-only; mandate validation, revocation, and ledger queries
  stay in Caracal CLI, Flow, or gateway control surfaces

## Entry points

- `examples/langchain_demo/app.py`: FastAPI app + UI, served with uvicorn
- `examples/langchain_demo/demo_runtime.py`: config-driven governed workflow
- `examples/langchain_demo/caracal/runtime_bridge.py`: local logic handlers for registered logic tools
- `examples/langchain_demo/runtime_config.py`: loader for manual `demo_config.json`

## Commands

Run governed artifact from CLI:

```bash
python -m examples.langchain_demo.caracal.main --mode mock --provider-strategy mixed
python -m examples.langchain_demo.caracal.main --mode real --provider-strategy mixed
```

Serve UI:

```bash
uvicorn examples.langchain_demo.app:app --host 127.0.0.1 --port 8090
```

## Required setup

Complete manual workspace setup before running:

- workspace
- principals
- providers (mock + real)
- tools (mock + real + local logic)
- source mandate + delegated mandates
- `examples/langchain_demo/demo_config.json`

See `examples/langchain_demo/README.md` for full CLI/TUI steps and exact provider/tool IDs.
