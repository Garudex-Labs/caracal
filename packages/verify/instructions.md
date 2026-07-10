# packages/verify

## Scope
- Covers the framework-neutral verification engine grouping under `packages/verify/`.

## Architecture Design
- The engine authenticates Caracal-issued bearer tokens and returns framework-neutral auth results.
- Framework adapters for Express, ASGI, FastMCP, and Go net/http live under `packages/adapters/`.

## Required
- Must keep each language implementation in its own child directory.
- Must consume identity and revocation through public package interfaces.
- Must keep authentication results typed and framework-neutral.

## Forbidden
- Must not host framework middleware or storage backends.
- Must not perform provider-specific request routing.
- Must not log plaintext tokens.

## Validation
- Validate through the touched child package and verify-engine tests for that language.

