---
name: policy-review
description: Use to review Caracal Rego policies for decision contract compliance, deny-by-default behavior, least privilege, deterministic logic, and activation readiness.
---
# Policy Review

## Procedure

1. Verify `package caracal.authz` and `import rego.v1`.
2. Verify deny-by-default behavior.
3. Verify the result contract includes `decision`, `evaluation_status`, `determining_policies`, and `diagnostics`.
4. Check resource and scope conditions for least privilege.
5. Check actor, subject, session, grant, and delegation conditions.
6. Identify undocumented input fields.
7. Identify nondeterministic or side-effecting logic.
8. Recommend validation, simulation, policy-set activation, and audit checks.

Only report issues that affect correctness, safety, maintainability, or production readiness.
