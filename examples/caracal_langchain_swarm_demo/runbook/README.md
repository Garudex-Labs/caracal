# Runbook

This runbook covers the operator path for the demo in broker mode, including baseline execution, governed execution, bootstrap, comparison, Flow/TUI checks, and troubleshooting.

## Assumptions

- You are running from the repository root.
- Python dependencies from `examples/caracal_langchain_swarm_demo/requirements.txt` are installed.
- Broker/runtime commands are available through `caracal`.
- Live governed runs require exact env values:
  - `CARACAL_API_KEY`
  - `CARACAL_ORCHESTRATOR_MANDATE_ID`
  - `CARACAL_FINANCE_MANDATE_ID`
  - `CARACAL_OPS_MANDATE_ID`
- Optional live revocation verification also requires `CARACAL_REVOCATION_REVOKER_ID`.

## Runtime Commands

Bring up the runtime:

```bash
caracal up
```

View logs:

```bash
caracal logs
```

Shut down services:

```bash
caracal down
```

Reset local runtime state:

```bash
caracal reset
```

## Baseline Procedure

Run deterministic baseline mode:

```bash
python -m examples.caracal_langchain_swarm_demo.baseline.main --mock always
```

Run OpenAI-backed baseline mode:

```bash
OPENAI_API_KEY=... python -m examples.caracal_langchain_swarm_demo.baseline.main --provider openai --mock auto
```

Run Gemini-backed baseline mode:

```bash
GOOGLE_API_KEY=... python -m examples.caracal_langchain_swarm_demo.baseline.main --provider gemini --mock auto
```

Inspect the artifact:
- `baseline/outputs/latest.json` contains `timeline`, `tool_invocation_summary`, `business_outcomes`, and `acceptance`.

## Bootstrap Procedure

Preview bootstrap without mutation:

```bash
python -m examples.caracal_langchain_swarm_demo.bootstrap.main
```

Provision the workspace, providers, tools, policy, mandates, attestation nonce, and token request:

```bash
python -m examples.caracal_langchain_swarm_demo.bootstrap.main --apply
```

Restart the runtime with attestation env values:

```bash
python -m examples.caracal_langchain_swarm_demo.bootstrap.main --apply --restart-runtime-for-attestation
```

Inspect the bootstrap artifact:
- `bootstrap/artifacts/bootstrap_artifacts.json`
- `bootstrap/artifacts/runtime_startup.env`

## CLI Sequence

The bootstrap script automates this, but the underlying sequence is:

1. `caracal workspace create ...` / `caracal workspace use ...`
2. `caracal principal register ...` for issuer, orchestrator, finance, and ops
3. `caracal provider add ...` for OpenAI, Gemini, and the internal provider
4. `caracal tool register ...` for direct API tools and local logic tools
5. `caracal tool preflight`
6. `caracal policy create ... --allow-delegation ...`
7. `caracal authority mandate ...`
8. `caracal authority delegate ...` if you want to model additional live delegation edges
9. `caracal authority revoke ...` for revocation verification

## Governed Procedure

Run deterministic governed mode:

```bash
python -m examples.caracal_langchain_swarm_demo.caracal.main --mock always
```

Run live governed mode:

```bash
CARACAL_API_KEY=... \
CARACAL_ORCHESTRATOR_MANDATE_ID=... \
CARACAL_FINANCE_MANDATE_ID=... \
CARACAL_OPS_MANDATE_ID=... \
python -m examples.caracal_langchain_swarm_demo.caracal.main --mock never
```

Run live governed mode with revocation verification:

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

Inspect the artifact:
- `caracal/outputs/latest.json` contains `delegation`, `revocation`, `authority_evidence`, `business_outcomes`, and `acceptance`.

## Comparison Procedure

Run both mock tracks and write a side-by-side artifact:

```bash
python -m examples.caracal_langchain_swarm_demo.compare_tracks
```

Inspect:
- `outputs/comparison.json`
- `comparison.md`
- `transcripts/baseline_mock.md`
- `transcripts/caracal_mock.md`

## Flow/TUI Verification

Use Flow/TUI to verify:

1. The three providers are visible, including the internal provider with `finance`, `ops`, and `orchestrator` resources.
2. The registered logic tools are visible with `execution_mode=local`.
3. The logic tools show the expected `handler_ref`.
4. The role mandates are visible for orchestrator, finance, and ops.
5. Authority actions show the expected scopes:
   - finance: `provider:swarm-internal:resource:finance` + `provider:swarm-internal:action:read`
   - ops: `provider:swarm-internal:resource:ops` + `provider:swarm-internal:action:read`
   - orchestrator: `provider:swarm-internal:resource:orchestrator` + `provider:swarm-internal:action:summarize`

## Troubleshooting

- Token rejection:
  - Confirm runtime health first.
  - Confirm `CARACAL_AIS_ATTESTATION_NONCE` and principal IDs match the bootstrap artifact.
- Tool mapping mismatch:
  - Re-run bootstrap apply.
  - Run `caracal tool preflight`.
  - Confirm the orchestrator tool is registered against `orchestrator/summarize`, not `ops/read`.
- Attestation startup failure:
  - Confirm Redis is reachable with the configured host/port.
  - Confirm the runtime was restarted with the generated env file when using startup attestation.
- Workspace mismatch:
  - Confirm the active workspace matches the one written in `bootstrap_artifacts.json`.
  - Re-run `caracal workspace use <name>` before manual CLI operations.
