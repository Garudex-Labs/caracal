---
id: ai-open-source-end-users-security-fail-closed-semantics
title: Fail-Closed Semantics
slug: /ai/open-source/end-users/security/fail-closed-semantics
sidebar_label: Fail-Closed Semantics
canonical_human: /open-source/end-users/security/fail-closed-semantics
applies_to: [oss]
edition: oss
audience: ai
page_type: concept
version: 1.0
status: authored
last_verified: 2026-04-27
source_files:
  - packages/caracal-server/caracal/core/mandate.py
  - core/authority.py
  - packages/caracal/caracal/runtime/hardcut_preflight.py
---

# Fail-Closed Semantics (AI)

> Canonical human page: [/open-source/end-users/security/fail-closed-semantics](/open-source/end-users/security/fail-closed-semantics)

## Definition

Deterministic machine-facing contract for fail-closed semantics in the `/ai/open-source/end-users/security/fail-closed-semantics` route scope.

## Inputs

| name | type | required | source | notes |
| --- | --- | --- | --- | --- |
| Workspace context | object | yes | packages/caracal-server/caracal/core/mandate.py | Workspace and principal scope for evaluation. |
| Authority context | object | conditional | packages/caracal-server/caracal/core/mandate.py | Policy, mandate, and delegation data when required. |
| Operation payload | map | yes | packages/caracal-server/caracal/core/mandate.py | Route-specific fields with canonical identifiers. |

## Outputs

| name | type | notes |
| --- | --- | --- |
| status | string | `ok` or classified error code. |
| result | object | Operation-specific fields and persisted identifiers. |
| verification | object | Read-after-write hints for deterministic checks. |

## Constraints

- Reject requests with missing required identifiers.
- Enforce fail-closed behavior for insufficient authority context.
- Preserve canonical identifier format and normalization rules.
- Require deterministic ordering for sequential state transitions.

## Steps

1. Normalize incoming field names and validate schema.
2. Resolve runtime and authority context for target workspace scope.
3. Evaluate preconditions and authorization invariants.
4. Execute operation and classify result as success or failure.
5. Return persisted identifiers and verification hints.

## Usage rules

- Do: provide explicit identifiers and avoid implicit defaults for security-sensitive fields.
- Do: run read-after-write verification before chaining dependent operations.
- Do not: infer cross-workspace permissions without explicit delegation evidence.
- Do not: treat partial payloads as success when `status` is not `ok`.

## Errors

| code | meaning | remediation |
| --- | --- | --- |
| INPUT_INVALID | Required field missing or malformed | Validate schema and retry with canonical names. |
| AUTHORITY_DENIED | Policy or mandate constraints fail | Correct scope, principal, policy, or mandate context. |
| PRECONDITION_FAILED | Required prior state absent | Complete prerequisite operation and retry. |
| RUNTIME_UNAVAILABLE | Runtime dependency unavailable | Restore service health and re-run. |

## Examples

```json
{
  "operation": "fail-closed-semantics",
  "status": "ok",
  "result": {
    "id": "example-id"
  },
  "verification": {
    "read_after_write": true
  }
}
```

## See also

- [/open-source/end-users/security/fail-closed-semantics](/open-source/end-users/security/fail-closed-semantics)
- [/ai/open-source/overview](/ai/open-source/overview)
- [/ai/resources/glossary](/ai/resources/glossary)
