---
id: ai-open-source-end-users-concepts-mandate
title: Mandate
slug: /ai/open-source/end-users/concepts/mandate
sidebar_label: Mandate
canonical_human: /open-source/end-users/concepts/mandate
applies_to: [oss]
edition: oss
audience: ai
page_type: concept
version: 1.0
status: stub
last_verified: 2026-04-27
source_files:
  - packages/caracal-server/caracal/core/mandate.py
  - core/authority.py
---

# Mandate (AI)

> Canonical human page: [/open-source/end-users/concepts/mandate](/open-source/end-users/concepts/mandate)

## Writing instructions

- Purpose: What a mandate is: a cryptographically signed, time-bound permission for a specific intent. Cover lifecycle (issue, validate, revoke), required fields, and fail-closed semantics.
- Page type: concept
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
