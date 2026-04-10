# Caracal LangChain Swarm Demo

This demo is built in two tracks:
- `baseline/`: plain LangChain multi-agent swarm (no Caracal authority boundary)
- `caracal/`: Caracal-governed swarm with explicit mandate, delegation, and revocation behavior

Bootstrap automation is available in `bootstrap/` for workspace/provider/tool/policy setup.
Shared acceptance and comparison artifacts live at the demo root:
- `fixtures/expected_outcomes.json`
- `outputs/comparison.json`

## Why this baseline uses LangChain built-ins

The baseline uses LangChain built-ins directly so the demo focuses on workflow logic:
- `create_agent(...)` for specialist and supervisor agents
- `@tool` for structured callable tools
- streaming via `agent.stream(..., stream_mode="values")`
- sub-agent-as-tool wrapper pattern for supervisor orchestration

## Quick Start (Baseline)

1. Install demo dependencies:

```bash
python -m pip install -r examples/caracal_langchain_swarm_demo/requirements.txt
```

2. Run baseline in deterministic mock mode:

```bash
python -m examples.caracal_langchain_swarm_demo.baseline.main --mock always
```

3. Run baseline with OpenAI key (auto-falls back to mock when key is missing):

```bash
OPENAI_API_KEY=... python -m examples.caracal_langchain_swarm_demo.baseline.main --provider openai --mock auto
```

4. Run baseline with Gemini key:

```bash
GOOGLE_API_KEY=... python -m examples.caracal_langchain_swarm_demo.baseline.main --provider gemini --mock auto
```

Output artifact is written to `examples/caracal_langchain_swarm_demo/baseline/outputs/latest.json` by default.
Both baseline and governed artifacts now include:
- `business_outcomes`: deterministic scenario findings shared across tracks
- `acceptance`: pass/fail checks against `fixtures/expected_outcomes.json`

## Quick Start (Bootstrap)

Preview bootstrap operations without mutating state:

```bash
python -m examples.caracal_langchain_swarm_demo.bootstrap.main
```

Run full bootstrap provisioning:

```bash
python -m examples.caracal_langchain_swarm_demo.bootstrap.main --apply
```

## Quick Start (Caracal Governed)

Run governed mock path:

```bash
python -m examples.caracal_langchain_swarm_demo.caracal.main --mock always
```

Run governed live path (requires API key + mandates):

```bash
CARACAL_API_KEY=... \
CARACAL_ORCHESTRATOR_MANDATE_ID=... \
CARACAL_FINANCE_MANDATE_ID=... \
CARACAL_OPS_MANDATE_ID=... \
python -m examples.caracal_langchain_swarm_demo.caracal.main --mock never
```

## Quick Start (Comparison)

Run the same scenario through both mock tracks and write a side-by-side comparison artifact:

```bash
python -m examples.caracal_langchain_swarm_demo.compare_tracks
```

This writes `examples/caracal_langchain_swarm_demo/outputs/comparison.json`.
