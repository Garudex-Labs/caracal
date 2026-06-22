---
name: safe-secret-handling
description: "Safely handle pasted API keys, bearer tokens, client secrets, private keys, authorization headers, and provider credentials."
---

# Safe Secret Handling

## Procedure

1. Detect sensitive values before repeating user input.
2. Replace raw values with safe masks such as `<api_key: masked abc...xyz>`.
3. Preserve only enough characters for safe identification.
4. Warn the user that credentials were detected.
5. Recommend removing or masking credentials before future sharing.
6. Do not ask the user to paste full secrets again.
7. Continue mapping using masked values, placeholders, or environment variable names.

Treat all provider credentials as secrets.
