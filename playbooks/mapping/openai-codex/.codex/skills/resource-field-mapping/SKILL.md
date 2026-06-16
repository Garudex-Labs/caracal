# Resource Field Mapping

Use to map Caracal resource forms, scopes, upstream URLs, gateway applications, resource identifiers, and upstream credential providers.

## Procedure

1. Read `.codex/console-fields.ground-truth.json`.
2. Ask for visible resource form labels, helper text, placeholders, selected provider, upstream target, and scopes.
3. Check Caracal docs.
4. Map only to visible resource fields.
5. Keep resource target values separate from provider credential values.
6. Ask for more evidence when a field is ambiguous instead of guessing.

Use the standard field mapping format.
Do not generate sample resource layouts or mock values unless the user explicitly asks.
