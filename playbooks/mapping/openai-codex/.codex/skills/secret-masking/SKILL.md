# Secret Masking

Use to safely handle pasted API keys, bearer tokens, client secrets, private keys, authorization headers, and provider credentials.

## Procedure

1. Detect sensitive values before repeating user input.
2. Replace raw values with safe masks such as `<api_key: masked abc...xyz>`.
3. Preserve only enough characters for identification.
4. Do not ask the user to paste full secrets again.
5. Warn the user that credentials were detected and recommend redaction before future sharing.
6. Continue mapping using masked values or environment variable names.

Treat all provider credentials as secrets.
