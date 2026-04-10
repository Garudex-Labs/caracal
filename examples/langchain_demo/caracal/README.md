# Caracal Track

This folder now contains a first governed implementation with:
- SDK `tools.call(...)` authority boundary via [examples/caracal_langchain_swarm_demo/caracal/client.py](examples/caracal_langchain_swarm_demo/caracal/client.py)
- local logic runtime bridge handlers for `handler_ref` binding in [examples/caracal_langchain_swarm_demo/caracal/runtime_bridge.py](examples/caracal_langchain_swarm_demo/caracal/runtime_bridge.py)
- governed workflow runner in [examples/caracal_langchain_swarm_demo/caracal/workflow.py](examples/caracal_langchain_swarm_demo/caracal/workflow.py)
- CLI runner in [examples/caracal_langchain_swarm_demo/caracal/main.py](examples/caracal_langchain_swarm_demo/caracal/main.py)
- deterministic delegation and revocation simulation with denial evidence capture in governed artifacts
- explicit orchestrator authority scope: `provider:swarm-internal:resource:orchestrator` + `provider:swarm-internal:action:summarize`
- shared `business_outcomes` and `acceptance` payloads matching the baseline track

## Quick Start (Mock Governed)

```bash
python -m examples.caracal_langchain_swarm_demo.caracal.main --mock always
```

## Quick Start (Live Governed)

Live mode expects:
- `CARACAL_API_KEY`
- role mandate IDs for orchestrator/finance/ops
- logic tool registrations completed by bootstrap apply flow
- optional revoker principal id for live revocation test (`CARACAL_REVOCATION_REVOKER_ID`)

Example:

```bash
CARACAL_API_KEY=... \
CARACAL_ORCHESTRATOR_MANDATE_ID=... \
CARACAL_FINANCE_MANDATE_ID=... \
CARACAL_OPS_MANDATE_ID=... \
python -m examples.caracal_langchain_swarm_demo.caracal.main --mock never
```

Live revocation validation example:

```bash
CARACAL_API_KEY=... \
CARACAL_ORCHESTRATOR_MANDATE_ID=... \
CARACAL_FINANCE_MANDATE_ID=... \
CARACAL_OPS_MANDATE_ID=... \
CARACAL_REVOCATION_REVOKER_ID=... \
python -m examples.caracal_langchain_swarm_demo.caracal.main \
	--mock never \
	--enable-live-revocation \
	--require-revocation-denial
```

Output artifact default path:
- [examples/caracal_langchain_swarm_demo/caracal/outputs/latest.json](examples/caracal_langchain_swarm_demo/caracal/outputs/latest.json)

Artifact fields include:
- `delegation`: source mandate, edge list, edge verification flag
- `revocation`: revoked mandate id and denied-after-revoke evidence
- `authority_evidence`: ordered authority events for audit-style inspection
- `business_outcomes`: deterministic scenario findings shared with the baseline track
- `acceptance`: pass/fail checks against the locked expected output fixture
