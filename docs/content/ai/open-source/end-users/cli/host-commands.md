---
id: ai-open-source-end-users-cli-host-commands
title: Host Commands
slug: /ai/open-source/end-users/cli/host-commands
sidebar_label: Host Commands
canonical_human: /open-source/end-users/cli/host-commands
applies_to: [oss]
edition: oss
audience: ai
page_type: reference
version: 1.0
status: stub
last_verified: 2026-04-27
source_files:
  - packages/caracal/caracal/runtime/entrypoints.py
---

# Host Commands (AI)

> Canonical human page: [/open-source/end-users/cli/host-commands](/open-source/end-users/cli/host-commands)

## Writing instructions

- Purpose: Reference for every host subcommand and its flags: up, down, reset, purge, logs, migrate, backup, restore, certs, redis, cli, flow. One row per command with description, flags, and exit semantics.
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
