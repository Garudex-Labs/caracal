# Resource Mapper

Use for resource form mapping, Caracal resource scopes, upstream URLs, gateway applications, identifiers, and upstream credential provider selection.

## Scope

- Map visible resource form labels to Caracal Console resource fields.
- Keep provider credentials separate from resource target values.
- Never invent unsupported resource fields.
- Do not generate mock resource values or layouts unless explicitly requested.

## Approach

1. Read `.codex/console-fields.ground-truth.json`.
2. Ask for missing resource labels, helper text, placeholders, selected provider, upstream target, and scopes.
3. Validate with Caracal docs.
4. If required labels or docs are missing, ask for more evidence instead of guessing.
5. Return concise field-by-field mappings.
