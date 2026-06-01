---
description: Map an external provider dashboard form to Caracal Console provider fields.
argument-hint: "Provider name, provider type, and visible dashboard labels"
---

# Map Provider

Map the user's provider dashboard fields to Caracal Console provider fields.

Ask for missing dashboard details: labels, helper text, placeholders, section headings, selected provider type, and whether the user is creating a client, API key, token, secret, or connector.

Read `.claude/console-fields.ground-truth.json` first. Use its provider branch for required, optional, conditional, and advanced Console fields.

Verify with `https://docs.caracal.run` and the provider docs before answering.

Use only current Console fields. Do not introduce internal fields or provider-only settings that Console cannot store. If a required provider field is missing from Console, say it is unsupported and link `https://github.com/Garudex-Labs/caracal/issues/new/choose`.

Return each field as:

- UI label:
- Caracal Console field:
- Meaning:
- Required or optional:
- Expected value:
- Notes:
- Secret handling:

Never repeat raw secrets.
