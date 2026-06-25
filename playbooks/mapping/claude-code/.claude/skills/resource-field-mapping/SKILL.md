---
name: resource-field-mapping
description: Map Resource forms, scopes, upstream URLs, gateway applications, resource identifiers, and upstream credential providers to visible Caracal web console Resource fields.
allowed-tools: Read, Grep, WebFetch
---

# Resource Field Mapping

## Procedure

1. Read `.claude/console-fields.ground-truth.json`.
2. Ask for visible Resource form labels, helper text, placeholders, selected provider, upstream target, and scopes.
3. Check Caracal docs when available.
4. Map only to visible Resource fields.
5. Keep Resource target and routing values separate from Provider credential values.

Use the standard field mapping format.
