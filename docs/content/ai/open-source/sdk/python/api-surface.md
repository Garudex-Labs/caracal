---
id: ai-open-source-sdk-python-api-surface
title: Python API Surface
slug: /ai/open-source/sdk/python/api-surface
sidebar_label: Python API Surface
canonical_human: /open-source/sdk/python/api-surface
applies_to: [oss]
edition: oss
audience: ai
page_type: reference
version: 1.0
status: stub
last_verified: 2026-04-27
source_files:
  - sdk/python-sdk/src/caracal_sdk/__init__.py
---

# Python API Surface (AI)

> Canonical human page: [/open-source/sdk/python/api-surface](/open-source/sdk/python/api-surface)

## Writing instructions

- Purpose: Every public export from caracal_sdk.__init__. One row per symbol with a one-line description.
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
