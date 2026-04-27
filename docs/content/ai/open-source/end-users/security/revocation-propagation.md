---
id: ai-open-source-end-users-security-revocation-propagation
title: Revocation Propagation
slug: /ai/open-source/end-users/security/revocation-propagation
sidebar_label: Revocation Propagation
canonical_human: /open-source/end-users/security/revocation-propagation
applies_to: [oss]
edition: oss
audience: ai
page_type: concept
version: 1.0
status: stub
last_verified: 2026-04-27
source_files:
  - packages/caracal-server/caracal/core/revocation.py
  - core/revocation_publishers.py
---

# Revocation Propagation (AI)

> Canonical human page: [/open-source/end-users/security/revocation-propagation](/open-source/end-users/security/revocation-propagation)

## Writing instructions

- Purpose: How a revocation reaches running services. Cover the Redis revocation events channel and the publisher mode env var.
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
