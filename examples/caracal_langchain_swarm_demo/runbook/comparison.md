# Baseline vs Governed

This demo now makes the before/after difference explicit in both code and artifacts.

## Shared Ground Truth

Both tracks use the same:
- input scenario: `baseline/fixtures/scenario.json`
- expected outcomes: `fixtures/expected_outcomes.json`
- acceptance evaluator: `acceptance.py`
- deterministic business analysis helpers: `scenario_analysis.py`

That means the business result is judged against one shared contract even when the execution model changes.

## Execution Boundary

- Baseline:
  - LangChain supervisor calls local tools and sub-agent wrappers directly.
  - There is no authority gate between the orchestrator and the tools.
- Governed:
  - Tool calls go through Caracal with an explicit `mandate_id`.
  - Local logic tools are bound through `handler_ref`.
  - Source comments mark the control points:
    - `CARACAL_MARKER: AUTH_BOUNDARY`
    - `CARACAL_MARKER: MANDATE_REQUIRED`
    - `CARACAL_MARKER: REVOCABLE_CALL`

## Permission Model

- Baseline:
  - Execution is permitted because the process can call the tool.
- Governed:
  - Execution is permitted only when the mandate scope matches the requested provider resource and action.
  - The orchestrator now has an explicit authority scope:
    - `provider:swarm-internal:resource:orchestrator`
    - `provider:swarm-internal:action:summarize`

## Revocation Behavior

- Baseline:
  - There is no native mid-run revocation story.
- Governed:
  - The mock governed path revokes the finance mandate during the workflow.
  - The artifact captures denied-after-revoke evidence in `revocation.denial_evidence`.

## Auditability

- Baseline:
  - Records timeline steps and tool invocation counts.
- Governed:
  - Records timeline steps plus delegation edges, validation events, revocation events, and denial evidence.

## Comparison Artifact

Run:

```bash
python -m examples.caracal_langchain_swarm_demo.compare_tracks
```

Inspect:
- `outputs/comparison.json`

Key checks in that artifact:
- `shared_business_outcomes_match`
- `baseline.acceptance_passed`
- `governed.acceptance_passed`
- authority/revocation differences
