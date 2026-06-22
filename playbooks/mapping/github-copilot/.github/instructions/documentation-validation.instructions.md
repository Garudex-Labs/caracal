---
description: "Use when checking Caracal docs, provider docs, Context7, or other documentation MCPs before explaining Provider and Resource field mappings."
---

# Documentation Validation

- Prefer `https://docs.caracal.run` for Caracal behavior.
- Prefer official provider docs for provider terminology and field requirements.
- Use Context7 or another documentation MCP when available.
- Compare docs against `.github/console-fields.ground-truth.json` before recommending exact values.
- Documentation overrides memory and assumptions.
- If documentation is unavailable, mark the point as unverified instead of guessing.
- If docs require a field or auth mode not exposed by Console, say it is unsupported and link `https://github.com/Garudex-Labs/caracal/issues/new/choose`.

Priority order: Caracal docs, official provider docs, connected documentation MCPs, repository guidance.
