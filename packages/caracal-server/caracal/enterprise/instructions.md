---
description: Apply when adding, editing, or reviewing enterprise license checks or exceptions.
applyTo: packages/caracal-server/caracal/enterprise/**
---

## Purpose
Enterprise license validation and enterprise-specific exception types.

## Rules
- All enterprise exception types are defined in `exceptions.py`; no new exception files.
- License validation logic lives in `__init__.py` or a dedicated `license.py` if it grows.
- This module must never import from `deployment/`, `cli/`, `flow/`, or `runtime/`.

## Constraints
- Forbidden: business logic beyond license validation in this module.
- Forbidden: network calls; license state is passed in, not fetched here.
- File names: `exceptions.py` and `__init__.py` only, unless a single new concern requires a new file.

## Imports
- Import from `caracal.exceptions` base types only.
- Never import from core business modules.

## Error Handling
- All failures raise subclasses of `EnterpriseError` defined in this module.
