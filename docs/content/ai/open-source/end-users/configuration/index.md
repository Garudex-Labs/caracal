---
id: ai-open-source-end-users-configuration-index
title: Configuration
slug: /ai/open-source/end-users/configuration
sidebar_label: Configuration
canonical_human: /open-source/end-users/configuration
applies_to: [oss]
edition: oss
audience: ai
page_type: hub
version: 1.0
status: stub
last_verified: 2026-04-27
source_files:
  - deploy/config/config.example.yaml
  - packages/caracal-server/caracal/config/settings.py
---

# Configuration (AI)

> Canonical human page: [/open-source/end-users/configuration](/open-source/end-users/configuration)

## Writing instructions

- Purpose: Explain config.yaml shape, file location, env var precedence, and link each block reference page.
- Page type: hub
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
