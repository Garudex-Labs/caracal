---
name: resource-field-mapping
description: "Map Resource forms, scopes, upstream URLs, gateway applications, resource identifiers, and upstream credential providers to visible Caracal Console Resource fields."
---

# Resource Field Mapping

## Procedure

1. Read `.github/console-fields.ground-truth.json`.
2. Ask for visible Resource form labels, helper text, placeholders, selected provider, upstream target, and scopes.
3. Apply field types, allowed options, validation metadata, and short descriptions before recommending exact values.
4. Check Caracal docs when available.
5. Map only to visible Resource fields.
6. Keep Resource target and routing values separate from Provider credential values.

Use the standard field mapping format from `AGENTS.md` with `Belongs to: Resource`.
