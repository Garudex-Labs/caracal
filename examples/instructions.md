---
description: Apply when adding, editing, or reviewing example applications.
applyTo: examples/**
---

## Purpose
Reference example applications demonstrating Caracal integration patterns.

## Rules
- Each example is a self-contained directory with its own `pyproject.toml` and `README.md` inside its own folder.
- Examples must use only the public Caracal SDK; no direct imports from `packages/`.
- Example tests live in `<example>/tests/`; use `pytest` with standard fixtures.
- Mock external services via `_mock/` directories within the example; no live external calls in tests.
- Each example must be independently installable without modifying the root workspace.

## Constraints
- Forbidden: adding example code that imports from `caracal.core`, `caracal.db`, or `caracal.runtime` directly.
- Forbidden: committing secrets or real API keys in example config files.
- Forbidden: referencing production endpoints in example code.
- Directory names: `camelCase` (e.g., `lynxCapital`).

## Testing
- Example tests must pass in isolation with `pytest` from within the example directory.
- All external service calls must be mocked via the `_mock/` server fixtures.
