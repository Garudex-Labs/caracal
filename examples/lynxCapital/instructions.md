# examples/lynxCapital

## Scope
- Covers the Lynx Capital Python demo application under `examples/lynxCapital/`.

## Architecture Design
- The demo is a production-style FastAPI, Jinja2, SSE, LangChain, LangGraph, and DeepAgents simulation.
- `app/` is the real application boundary; `_mock/` is the only provider simulation boundary.
- `config/company.yaml` owns company labels, regions, providers, scenarios, theme values, and swarm limits.
- `config/tenancy.yaml` plus `policies/manifest.json` own the identity model: one managed application per domain service (each its own trust boundary, owning one credential provider and one resource), the agent roles, the capability-to-scope mapping, and the customers (modelled as subjects).
- `app/services/partners.py` is the single bridge from application code to provider clients.
- `app/caracal.py` is the single seam from application code to Caracal; `app/tenancy.py` derives labels, scopes, and provisioning commands from the model.

## Required
- Must run as one Python 3.14+ application with no separate frontend build system.
- Must keep OpenAI-backed orchestration as the only LLM path and fail clearly when `OPENAI_API_KEY` is absent.
- Must keep all simulated provider behavior deterministic and case-based under `_mock/`.
- Must emit observable lifecycle events for every spawned, delegated, completed, failed, cancelled, or terminated agent.
- Must keep UI pages server-rendered with plain JavaScript enhancement and SSE from the same FastAPI app.
- Must keep tests under `tests/` and the provider ecosystem under `_mock/providerlab/`.
- Must keep the identity model config-driven through `config/tenancy.yaml` and `policies/manifest.json`; the SDK seam, provisioning, and policy must stay consistent with that single model.
- Must keep customer isolation enforced through per-customer subjects, least-privilege spawn grants, and default-deny policy.

## Forbidden
- Must not add mode switches, fallback providers, alternate orchestration frameworks, Celery, Temporal, or message brokers.
- Must not hard-code company copy, product labels, providers, regions, scenarios, or theme values outside `config/company.yaml`.
- Must not put mock-shaped code under `app/`.
- Must not use Node, npm, Vite, React, or bundled frontend assets.
- Must not leave spawned agents without a matching Console lifecycle event.
- Must not reintroduce a single shared allow-all baseline policy, or per-customer applications/DCR for operator-spawned agents.
- Must not hard-code customer ids, capability labels, resource scopes, or grants outside `config/tenancy.yaml` and `policies/`.
- Must not introduce environment variables that are not real Caracal workload variables; provisioning credentials stay in the separate operator file.

## Validation
- Validate with `pytest` from `examples/lynxCapital/` when the demo changes.
