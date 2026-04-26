---
description: "Use when creating, updating, or reviewing any instructions.md file in the codebase."
applyTo: "**/instructions.md"
---

# Directory Instructions Standard

## Scope
- Each `instructions.md` covers only the directory it lives in.

## Required
- Create `instructions.md` in every non-trivial directory with logic or structure.
- Keep exactly one `instructions.md` per directory.
- Define scope in the first bullet.
- List required rules first, forbidden rules next.
- Use `must`, `must not`, `only` — no optional or vague wording.
- Use bullet points only.
- Keep content short and actionable.

## Forbidden
- Must not duplicate rules from parent or sibling directories.
- Must not include pseudocode, general explanations, or long text.
- Must not contain legacy rules that do not match current code.
- Must not include cross-directory instructions.
- Must not use weak language: avoid `should`, `consider`, `may`, `prefer`.

## Markdown Files
- Only `root/README.md` and files under `docs/` may be `.md` files outside of `instructions.md`.
- Must not create or keep any `.md` file outside root and docs except `instructions.md`.
- Replace any existing non-root `README.md` with `instructions.md`.

## Update Triggers
- Update immediately when directory structure, naming rules, or patterns change.
- Delete or rewrite when instructions become outdated or unclear.

## Validation
- No `.md` files outside root and docs except `instructions.md`.
- `instructions.md` must match actual directory contents.
- No conflicting rules across directories.
- File must remain short and strict after every update.
