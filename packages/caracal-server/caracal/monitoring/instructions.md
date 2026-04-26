---
description: Apply when adding, editing, or reviewing monitoring, metrics, or Grafana dashboard definitions.
applyTo: packages/caracal-server/caracal/monitoring/**
---

## Purpose
Metrics collection, health check endpoints, and Grafana dashboard definitions.

## Rules
- Metrics are registered once at module import; no dynamic metric registration at runtime.
- Grafana dashboard JSON files live in `grafana/`; no dashboard logic in Python files.
- Health check logic must be synchronous and complete within 100ms.
- All metric names follow `caracal_<module>_<noun>_<unit>` format (e.g., `caracal_core_mandate_checks_total`).

## Constraints
- Forbidden: business logic in monitoring files; observe only, never mutate state.
- Forbidden: external network calls from monitoring modules.
- Forbidden: storing metric state outside Prometheus registry objects.
- File names: `snake_case.py`; dashboard files: `*.json` in `grafana/` only.

## Imports
- Import from `prometheus_client` and `caracal.exceptions` only.
- Never import from `core/`, `cli/`, or `deployment/` directly.

## Error Handling
- Metric collection failures must be logged and swallowed; never crash the monitored process.
