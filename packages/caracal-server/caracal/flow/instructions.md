---
description: Apply when adding, editing, or reviewing the TUI flow application.
applyTo: packages/caracal-server/caracal/flow/**
---

## Purpose
Textual TUI application for the `caracal flow` command: screens, components, workspace state, and SDK bridge.

## Rules
- Screen classes live in `screens/`; component classes live in `components/`.
- `state.py` holds all reactive app state; screens must not hold persistent state directly.
- `sdk_bridge.py` is the only file that calls SDK or core functions from the TUI layer.
- `workspace.py` manages workspace selection and config context for the TUI.
- `theme.py` holds all CSS/visual configuration; no inline styles in screen or component files.

## Constraints
- Forbidden: direct DB calls or vault operations in screens or components.
- Forbidden: business logic outside `sdk_bridge.py` and `workspace.py`.
- Forbidden: importing from `cli/` inside flow modules.
- Screen file names: `snake_case.py` under `screens/`; component names under `components/`.

## Imports
- Screens and components import from `caracal.flow.state`, `caracal.flow.sdk_bridge`, and `textual` only.
- `sdk_bridge.py` imports from `caracal.core` and `caracal.deployment`.

## Error Handling
- All errors from `sdk_bridge.py` are surfaced as TUI notifications; never crash the app loop.
