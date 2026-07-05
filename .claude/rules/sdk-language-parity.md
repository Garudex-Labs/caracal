---
description: "Use when adding, changing, or reviewing code in the multi-language client packages (sdk, admin, core, identity, oauth, revocation, verify, adapters, backends). Enforces functional capability parity across TypeScript, Python, and Go."
applyTo: "{packages/sdk/**,packages/admin/**,packages/core/**,packages/identity/**,packages/oauth/**,packages/revocation/**,packages/verify/**,packages/adapters/**,packages/backends/**}"
---

# SDK Language Parity

- Applies to the multi-language client packages: `packages/sdk`, `packages/admin`, `packages/core`, `packages/identity`, `packages/oauth`, `packages/revocation`, `packages/verify`, `packages/adapters`, and `packages/backends`. TypeScript, Python, and Go are equal first-class SDK languages.

## Required

- Must keep core capabilities functionally equivalent across TypeScript, Python, and Go: features, helpers, abstractions, lifecycle behavior, retry behavior, transports, credential management, and convenience APIs.
- Must implement each capability with the language's idiomatic, industry-standard patterns and built-in primitives; equivalence is functional, not literal translation.
- Must keep wire behavior identical across languages: paths, methods, query encoding, request bodies, response unwrapping, error codes, and error messages.
- Must keep reliability, security guarantees, and developer experience functionally equivalent across languages.
- When adding or changing a capability in one language, must port it to the other two languages in the same change.
- Must add equivalent tests in every language that receives a capability.
- Must keep SDK surfaces thin, framework-agnostic, and designed to minimize customer-written glue code.
- Framework adapters must stay thin per-ecosystem layers that delegate governance logic to the shared verification engine.

## Forbidden

- Must not land a capability, helper, or fix in one language while leaving the other languages behind.
- Must not treat any language as a second-class citizen through reduced scope, weaker guarantees, or delayed ports.
- Must not diverge retry policies, error semantics, or security behavior between languages.
- Must not introduce a language-specific capability that cannot be expressed idiomatically in the other two languages.
- Must not compensate for missing parity with documentation, examples, or customer glue code.
