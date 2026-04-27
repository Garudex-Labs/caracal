---
id: ai-open-source-sdk-reference-hook-points
title: Hook Points
slug: /ai/open-source/sdk/reference/hook-points
sidebar_label: Hook Points
canonical_human: /open-source/sdk/reference/hook-points
applies_to: [oss]
edition: oss
audience: ai
page_type: reference
version: 1.0
status: stub
last_verified: 2026-04-27
source_files:
  - sdk/python-sdk/src/caracal_sdk/hooks.py
  - sdk/node-sdk/src/hooks.ts
---

# Hook Points (AI)

> Canonical human page: [/open-source/sdk/reference/hook-points](/open-source/sdk/reference/hook-points)

## Writing instructions

- Purpose: Every hook the HookRegistry exposes, with payload and ordering rules.
- Page type: reference
- Edition: oss
- Audience: ai

## Required structure (fixed schema)

Use these section headers in order. Omit any section that is genuinely empty.

1. `## Definition` - one sentence.
2. `## Inputs` - table: name, type, required, source, notes.
3. `## Outputs` - table: name, type, notes.
4. `## Constraints` - bullet list of invariants and limits.
5. `## Steps` - numbered, deterministic procedure.
6. `## Usage rules` - do / do not bullets.
7. `## Errors` - table: code, meaning, remediation.
8. `## Examples` - minimal runnable snippets.
9. `## See also` - related AI pages first, human pages second.

## Quality rules

- No prose, no narrative, no marketing.
- Compact, structured, instruction-first.
- Cite only the source files listed in front matter.
- Keep under 200 lines.
