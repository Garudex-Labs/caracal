---
name: policy-review
description: Use to review Caracal policy data documents for data document shape, platform decision contract alignment, least privilege, deterministic data, and activation readiness.
---
# Policy Review

## Procedure

1. Verify `package caracal.authz` and `import rego.v1`.
2. Verify the platform decision contract denies by default and that data only grants or narrows.
3. Verify the document defines only `app_ids`, `grants`, `confinement`, or `restrict` and never a `result` rule.
4. Check resource and scope conditions for least privilege.
5. Check actor, subject, session, grant, and delegation conditions.
6. Identify undocumented input fields.
7. Identify nondeterministic or side-effecting logic.
8. Recommend validation, simulation, policy-set activation, and audit checks.

Only report issues that affect correctness, safety, maintainability, or production readiness.
