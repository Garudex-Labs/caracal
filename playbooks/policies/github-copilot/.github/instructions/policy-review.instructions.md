---
description: "Use when reviewing Caracal policy data documents for data document shape, platform decision contract alignment, least privilege, deterministic data, and activation readiness."
---
# Policy Review

- Verify `package caracal.authz` and `import rego.v1`.
- Verify the platform decision contract denies by default and that data only grants or narrows.
- Verify the document defines only `app_ids`, `grants`, `confinement`, `restrict`, `risk`, or `approval_tiers` and never a `result` rule.
- Check resource and scope conditions for least privilege.
- Check actor, subject, session, grant, and delegation conditions.
- Check that every `risk` tier referenced by `approval_tiers` is classified and that gated scopes are intended to require human approval.
- Identify undocumented input fields.
- Identify nondeterministic or side-effecting logic.
- Identify cases where a simpler grant, confinement, or restriction shape would be safer.
- Recommend validation, simulation, policy-set activation, and audit checks.

Only report issues that affect correctness, safety, maintainability, or production readiness.
