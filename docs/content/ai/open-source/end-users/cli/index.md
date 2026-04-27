---
id: ai-open-source-end-users-cli-index
title: CLI
slug: /ai/open-source/end-users/cli
sidebar_label: CLI
canonical_human: /open-source/end-users/cli
applies_to: [oss]
edition: oss
audience: ai
page_type: hub
version: 1.0
status: authored
last_verified: 2026-04-27
source_files:
  - packages/caracal/caracal/runtime/entrypoints.py
  - packages/caracal-server/caracal/cli/main.py
---

# CLI (AI)

> Canonical human page: [/open-source/end-users/cli](/open-source/end-users/cli)

## Definition

Deterministic machine-facing contract for `index` CLI operations.

## Inputs

| name | type | required | source | notes |
| --- | --- | --- | --- | --- |
| workspace_context | object | conditional | CLI/runtime interfaces | Required for workspace-scoped operations. |
| command_args | map | yes | CLI/runtime interfaces | Normalized command parameters. |
| authority_context | object | conditional | CLI/runtime interfaces | Required for mutating authority state. |

## Outputs

| name | type | notes |
| --- | --- | --- |
| exit_code | integer | `0` success, non-zero failure. |
| result | object | Operation-specific payload. |
| verification | object | Read-after-write validation hints. |

## Constraints

- Validate required scope identifiers before execution.
- Reject authority-sensitive mutations without required context.
- Preserve canonical identifier formatting in input/output.
- Fail with explicit classification when runtime dependencies are unavailable.

## Steps

1. Parse command and normalize arguments.
2. Resolve workspace and authority context.
3. Evaluate preconditions and execute operation.
4. Return result and verification hints.
5. Perform read-after-write confirmation for mutating paths.

## Usage rules

- Do: provide explicit identifiers and avoid implicit scope assumptions.
- Do: classify and surface errors deterministically.
- Do not: treat runtime connectivity as authorization success.
- Do not: chain dependent operations without validation.

## Errors

| code | meaning | remediation |
| --- | --- | --- |
| INPUT_INVALID | malformed or incomplete args | correct request shape and retry. |
| AUTHORITY_DENIED | constraints reject operation | adjust policy/mandate/scope and retry. |
| CONTEXT_MISSING | required scope context absent | supply workspace/principal context. |
| RUNTIME_UNAVAILABLE | dependency failure | restore runtime health and retry. |

## Examples

```json
{
  "operation": "index",
  "exit_code": 0,
  "result": {"id": "example-id"}
}
```

## See also

- [/open-source/end-users/cli](/open-source/end-users/cli)
- [/ai/open-source/end-users/cli](/ai/open-source/end-users/cli)
- [/ai/open-source/end-users/cli/doctor](/ai/open-source/end-users/cli/doctor)
