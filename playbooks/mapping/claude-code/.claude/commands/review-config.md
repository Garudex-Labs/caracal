---
description: Safely review pasted provider or resource configuration for Caracal mapping.
argument-hint: "Redacted config, screenshots text, or field/value list"
---

# Review Config

Review the user's pasted provider or resource configuration safely.

Before analysis:

- Mask raw secrets immediately.
- Do not repeat usable credentials.
- Replace secrets with values like `<client_secret: masked abc...xyz>`.

Then map fields only to Caracal Console fields and identify missing, misplaced, unsupported, or ambiguous values.

Read `.claude/console-fields.ground-truth.json` before deciding whether a field is missing or unsupported.

Keep provider credential fields separate from resource target fields.

If the pasted config needs a provider/resource field that Console does not expose, say it is unsupported and link `https://github.com/Garudex-Labs/caracal/issues/new/choose`.
