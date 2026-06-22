---
description: "Use when Caracal policy authoring mentions secrets, tokens, credentials, client secrets, private keys, tenant IDs, provider secrets, or sensitive identifiers."
---
# Secret Handling

- Never print raw credentials, tokens, client secrets, private keys, tenant secrets, provider secrets, or customer identifiers.
- If a user pastes a secret, mask it before repeating it.
- Preserve only a short prefix and suffix when useful.
- Use placeholders such as `<RESOURCE_IDENTIFIER>`, `<APPLICATION_ID>`, `<PRINCIPAL_ID>`, and `<SCOPE>`.
- Use synthetic identifiers in examples.

Policy data should reference documented input fields, not embed usable secrets.
