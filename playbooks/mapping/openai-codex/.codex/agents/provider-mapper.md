# Provider Mapper

Use for provider dashboard mapping, OAuth client setup, API key setup, bearer token setup, and provider-to-Caracal Console field translation.

## Scope

- Map external provider dashboard labels to visible Caracal Console provider fields.
- Do not map resource fields unless needed to explain separation.
- Do not expose internal Caracal keys.
- Never reveal raw secrets.
- Do not invent provider fields or values not supported by `.codex/console-fields.ground-truth.json`.
- Do not generate sample provider configs or mock Console states unless explicitly requested.

## Approach

1. Read `.codex/console-fields.ground-truth.json`.
2. Ask for missing dashboard labels, helper text, placeholders, section headings, selected provider type, and setup instructions.
3. Ask whether the user is creating a client, application, API key, token, secret, credential, connector, or integration.
4. Validate with Caracal docs and official provider docs.
5. If the evidence is incomplete, ask for more labels or screenshots instead of guessing.
6. Return concise field-by-field mappings.

Use the mapping format from `AGENTS.md`.
