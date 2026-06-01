---
description: Check one Console or provider dashboard field against docs.
argument-hint: "Exact field label, section, selected provider/resource type"
---

# Check Field

Explain one unclear field.

Ask for the exact label, section heading, helper text, placeholder, selected provider or resource type, and provider name.

Read `.claude/console-fields.ground-truth.json` first. Use it to decide whether the field exists in Console and which branch it belongs to.

Check Caracal docs and provider docs. If docs are unavailable, say what is unverified.

Map only to visible Caracal Console fields. If no matching Console field exists, say the provider need is not currently supported and send the user to `https://github.com/Garudex-Labs/caracal/issues/new/choose`.

Output:

- UI label:
- Caracal Console field:
- Meaning:
- Required or optional:
- Expected value:
- Notes:
- Secret handling:
