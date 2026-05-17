# examples/lynxCapital

## Scope
- Covers the Lynx Capital Python demo application under `examples/lynxCapital/`.

## Architecture Design
- The demo is a production-style FastAPI, Jinja2, SSE, LangChain, LangGraph, and DeepAgents simulation.
- `app/` is the real application boundary; `_mock/` is the only external-provider boundary.
- `config/company.yaml` owns company labels, regions, providers, scenarios, theme values, and swarm limits.
- `app/services/registry.py` is the single bridge from application code to mock providers.

## Required
- Must run as one Python 3.14+ application with no separate frontend build system.
- Must keep OpenAI-backed orchestration as the only LLM path and fail clearly when `OPENAI_API_KEY` is absent.
- Must keep all external provider behavior deterministic and case-based under `_mock/`.
- Must emit observable lifecycle events for every spawned, delegated, completed, failed, cancelled, or terminated agent.
- Must keep UI pages server-rendered with plain JavaScript enhancement and SSE from the same FastAPI app.
- Must keep tests under `tests/` and mock SDK shims under `_mock/sdk/`.

## Forbidden
- Must not add runtime mode switches, fallback providers, alternate orchestration frameworks, Celery, Temporal, or message brokers.
- Must not hard-code company copy, product labels, providers, regions, scenarios, or theme values outside `config/company.yaml`.
- Must not put mock-shaped code under `app/`.
- Must not use Node, npm, Vite, React, or bundled frontend assets.
- Must not leave spawned agents without a matching terminal lifecycle event.

## Validation
- Validate with `pytest` from `examples/lynxCapital/` when the demo changes.

