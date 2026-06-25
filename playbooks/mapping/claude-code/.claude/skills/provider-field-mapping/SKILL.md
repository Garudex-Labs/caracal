---
name: provider-field-mapping
description: Map provider dashboard labels, OAuth client fields, API keys, bearer tokens, and connector setup to visible Caracal web console Provider fields.
allowed-tools: Read, Grep, WebFetch
---

# Provider Field Mapping

## Procedure

1. Read `.claude/console-fields.ground-truth.json`.
2. Identify the selected Provider type.
3. Ask for visible labels, helper text, placeholders, section headings, and provider setup steps.
4. Ask whether the provider is creating a client, application, API key, token, secret, credential, connector, or integration.
5. Check Caracal docs and official provider docs when available.
6. Map only to visible Console Provider fields.
7. If Console lacks a required provider field, use the unsupported output from `CLAUDE.md`.

Keep output short and use the standard field mapping format.
