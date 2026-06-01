---
name: rego-authoring
description: Use to write production-ready Caracal Rego policies after requirements and input fields are verified.
---
# Rego Authoring

## Procedure

1. Use `package caracal.authz`.
2. Use `import rego.v1`.
3. Start with a deny-by-default `result`.
4. Return `decision`, `evaluation_status`, `determining_policies`, and `diagnostics`.
5. Check resource identifiers and requested scopes explicitly.
6. Add actor, subject, session, grant, or delegation checks only when verified.
7. Use time-based rules only when the relevant time or window is supplied in documented policy input.
8. Keep logic deterministic and side-effect free.
9. Provide representative allow and deny simulation cases.

Do not use network calls, wall-clock time, random values, runtime filesystem access, or invented fields.
