---
name: secret-handling
description: Use when Caracal policy authoring mentions secrets, tokens, credentials, client secrets, private keys, tenant IDs, provider secrets, or sensitive identifiers.
---
# Secret Handling

## Procedure

1. Never print raw credentials, tokens, client secrets, private keys, tenant secrets, provider secrets, or customer identifiers.
2. If a user pastes a secret, mask it before repeating it.
3. Preserve only a short prefix and suffix when useful.
4. Use placeholders such as `<RESOURCE_IDENTIFIER>`, `<APPLICATION_ID>`, `<PRINCIPAL_ID>`, and `<SCOPE>`.
5. Use synthetic identifiers in examples.

Policies should evaluate documented input fields, not embed usable secrets.
