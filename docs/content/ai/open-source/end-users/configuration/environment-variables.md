---
id: ai-open-source-end-users-configuration-environment-variables
title: Environment Variables
slug: /ai/open-source/end-users/configuration/environment-variables
sidebar_label: Environment Variables
canonical_human: /open-source/end-users/configuration/environment-variables
applies_to: [oss]
edition: oss
audience: ai
page_type: reference
version: 1.0
status: stub
last_verified: 2026-04-27
source_files:
  - packages/caracal/caracal/runtime/entrypoints.py
  - packages/caracal-server/caracal/config/settings.py
---

# Environment Variables (AI)

> Canonical human page: [/open-source/end-users/configuration/environment-variables](/open-source/end-users/configuration/environment-variables)

## Writing instructions

- Purpose: Catalogue of CCL_* env vars used by OSS. One row per variable with default, role, and source file. CCLE_* env vars belong to the Enterprise reference.
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
