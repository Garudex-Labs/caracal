# examples/lynxCapital

## Scope
- Covers the Lynx Capital Python demo application under `examples/lynxCapital/`.

## Architecture Design
- The demo is a production-style FastAPI, Jinja2, SSE, LangChain, LangGraph, and DeepAgents simulation.
- `app/` is the real application boundary; `_mock/` is the only provider simulation boundary.
- `config/company.yaml` owns company labels, regions, providers, scenarios, theme values, and swarm limits.
- `config/tenancy.yaml` plus `policies/` own the identity model: one managed application per permission boundary, the twenty partner credential providers in their exact Caracal provider-kind config shapes, the per-application resource views the Gateway binds, and the role-to-scope grants every spawned agent is narrowed to.
- `app/services/partners.py` is the single bridge from application code to provider calls; with Caracal enabled every call routes through the Gateway under the calling agent's authority.
- `app/caracal.py` is the single seam from application code to Caracal; `app/agents/runner.py` owns per-agent session lifecycle; `app/tenancy.py` derives labels, scopes, views, policy data, and provisioning commands from the model.

## Required
- Must run as one Python 3.14+ application with no separate frontend build system.
- Must keep OpenAI-backed orchestration as the only LLM path and fail clearly when `OPENAI_API_KEY` is absent.
- Must keep all simulated provider behavior deterministic and case-based under `_mock/`.
- Must emit observable lifecycle events for every spawned, delegated, completed, failed, cancelled, or terminated agent.
- Must keep UI pages server-rendered with plain JavaScript enhancement and SSE from the same FastAPI app.
- Must keep tests under `tests/` and the provider ecosystem under `_mock/providerlab/`.
- Must keep the identity model config-driven through `config/tenancy.yaml` and `policies/`; the SDK seam, agent runner, provisioning, and policy must stay consistent with that single model.
- Must keep boundary isolation enforced through per-application credentials, per-agent sessions with role labels, least-privilege spawn grants, and default-deny policy.

## Forbidden
- Must not add mode switches, fallback providers, alternate orchestration frameworks, Celery, Temporal, or message brokers.
- Must not hard-code company copy, product labels, providers, regions, scenarios, or theme values outside `config/company.yaml`.
- Must not put mock-shaped code under `app/`.
- Must not use Node, npm, Vite, React, or bundled frontend assets.
- Must not leave spawned agents without a matching Console lifecycle event.
- Must not reintroduce a single shared allow-all baseline policy, a single application for the whole swarm, or direct provider access outside `_mock/` and explicit simulation mode.
- Must not hard-code role names, resource scopes, view identifiers, or grants outside `config/tenancy.yaml` and `policies/`.
- Must not introduce environment variables that are not real Caracal workload variables; provisioning credentials stay in the separate operator file.

## Validation
- Validate with `pytest` from `examples/lynxCapital/` when the demo changes.
