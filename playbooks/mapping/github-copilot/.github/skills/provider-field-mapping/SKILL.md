---
name: provider-field-mapping
description: "Map provider dashboard labels, OAuth client fields, API keys, bearer tokens, and connector setup to visible Caracal Console Provider fields."
---

# Provider Field Mapping

## Procedure

1. Read `.github/console-fields.ground-truth.json`.
2. Identify the selected Provider type.
3. Ask for visible labels, helper text, placeholders, section headings, and provider setup steps.
4. Ask whether the provider is creating a client, application, API key, token, secret, credential, connector, or integration.
5. Apply field types, allowed options, validation metadata, and short descriptions before recommending exact values.
6. Check Caracal docs and official provider docs when available.
7. Map only to visible Console Provider fields.
8. If Console lacks a required provider field, use the unsupported output from `AGENTS.md`.

Keep output short and use the standard field mapping format from `AGENTS.md` with `Belongs to: Provider`.
