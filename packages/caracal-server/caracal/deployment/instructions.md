---
description: Apply when adding, editing, or reviewing deployment mode, broker, sync, or edition logic.
applyTo: packages/caracal-server/caracal/deployment/**
---

## Purpose
Deployment mode detection, broker lifecycle, enterprise license and runtime config, edition gating, and config management.

## Rules
- `mode.py` is the single authority for deployment mode resolution; all mode checks import from it.
- `edition_adapter.py` gates all enterprise-only features; no inline edition checks elsewhere.
- `broker.py` owns broker process lifecycle; nothing else starts or stops the broker.
- `config_manager.py` manages runtime config state; `secrets_adapter.py` handles secret resolution.

## Constraints
- Forbidden: enterprise logic outside `edition_adapter.py` and `enterprise_*.py` files.
- Forbidden: direct subprocess calls outside `broker.py`.
- Forbidden: importing from `cli/` or `flow/`.
- File names: `snake_case.py` matching the single concern.

## Imports
- Import from `caracal.core`, `caracal.config.settings`, and `caracal.exceptions` only.
- `enterprise_*.py` files may import from `caracal.enterprise`.

## Error Handling
- Edition violations raise `EnterpriseFeatureRequiredError`.
- Sync failures raise errors from `caracal.exceptions`; never suppress and continue silently.
