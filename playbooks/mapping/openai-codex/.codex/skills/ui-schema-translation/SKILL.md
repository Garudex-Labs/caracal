# UI Schema Translation

Use to translate UI labels, helper text, placeholders, and provider terminology into Caracal Console field mappings.

## Procedure

1. Collect exact UI labels, helper text, placeholders, and section headings.
2. Match labels to `.codex/console-fields.ground-truth.json`.
3. Preserve provider terminology when explaining provider-side setup.
4. Output `UI label -> Caracal field -> meaning -> expected value`.
5. Ask for exact labels when a field is ambiguous.

Never expose internal Caracal keys.
Do not invent UI labels, helper text, or screen structure from memory.
