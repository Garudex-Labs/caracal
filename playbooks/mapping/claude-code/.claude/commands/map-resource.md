---
description: Map a Caracal resource form to visible Console resource fields.
argument-hint: "Resource form labels, provider binding, scopes, and upstream target"
---

# Map Resource

Map the user's resource form fields to Caracal Console resource fields.

Ask for the exact Console labels, helper text, placeholders, selected provider, upstream target, and scopes.

Read `.claude/console-fields.ground-truth.json` first. Use its resource section for required, optional, conditional, and advanced Console fields.

Keep resource fields separate from provider fields:

- Resource Console fields: resource name, Caracal resource scopes, upstream URL, gateway application, resource identifier, upstream credential provider
- Provider Console fields: provider type and upstream credential details

Verify with `https://docs.caracal.run` before answering.

Return the standard field mapping format only.

If the resource needs a field Console does not expose, say it is unsupported and link `https://github.com/Garudex-Labs/caracal/issues/new/choose`.
