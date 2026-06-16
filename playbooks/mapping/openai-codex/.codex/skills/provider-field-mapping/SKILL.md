# Provider Field Mapping

Use to map provider dashboard labels, OAuth client fields, API keys, bearer tokens, and connector setup to visible Caracal Console provider fields.

## Procedure

1. Read `.codex/console-fields.ground-truth.json`.
2. Identify the selected provider type.
3. Ask for visible labels, helper text, placeholders, section headings, and provider setup instructions.
4. Check Caracal docs and official provider docs.
5. Map only to visible Console provider fields.
6. If evidence is incomplete, ask for more labels, screenshots, or helper text instead of guessing.
7. If Console lacks a required provider field, use the unsupported output from `AGENTS.md`.

Keep output short and use the standard field mapping format.
Do not generate mock provider configs unless the user explicitly asks for examples.
