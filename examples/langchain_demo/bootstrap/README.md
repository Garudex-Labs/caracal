# Bootstrap

This folder now includes an idempotent bootstrap runner at [examples/caracal_langchain_swarm_demo/bootstrap/main.py](examples/caracal_langchain_swarm_demo/bootstrap/main.py).

Implemented capabilities:
- validates runtime prerequisites before mutation
- validates demo tool bindings and `handler_ref` contracts before mutation
- starts runtime services (optional)
- ensures workspace/principals/providers/tools/policy/mandates
- runs tool registry preflight and fails on drift
- issues AIS startup attestation nonce (Redis-backed)
- writes startup environment values to an env file
- probes runtime health and requests an AIS token
- persists a structured bootstrap artifact JSON

## Commands

Dry-run preview (default, no mutation):

```bash
python -m examples.caracal_langchain_swarm_demo.bootstrap.main
```

Apply mode (provision resources):

```bash
python -m examples.caracal_langchain_swarm_demo.bootstrap.main --apply
```

Apply and restart runtime with attestation startup env values:

```bash
python -m examples.caracal_langchain_swarm_demo.bootstrap.main --apply --restart-runtime-for-attestation
```

Useful options:
- `--workspace <name>`
- `--skip-runtime-start`
- `--runtime-base-url http://127.0.0.1:8000`
- `--token-url <override-url>`
- `--openai-api-key <key>`
- `--google-api-key <key>`
- `--require-token`

Artifacts:
- JSON artifact: [examples/caracal_langchain_swarm_demo/bootstrap/artifacts](examples/caracal_langchain_swarm_demo/bootstrap/artifacts)
- Runtime env values: [examples/caracal_langchain_swarm_demo/bootstrap/artifacts](examples/caracal_langchain_swarm_demo/bootstrap/artifacts)

Artifact fields now include:
- `binding_contract.validated`: local tool binding contract verification passed
- `providers`: registered provider set, including the explicit `orchestrator/summarize` internal scope
- `mandates`: role-specific mandate IDs used by the governed demo
