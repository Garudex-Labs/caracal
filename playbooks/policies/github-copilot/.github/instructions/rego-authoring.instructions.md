---
description: "Use when authoring production-ready Caracal policy data documents after requirements and input fields are verified."
---
# Rego Authoring

- Start with the `# caracal:data-document` directive on the first line.
- Use `package caracal.authz`.
- Use `import rego.v1`.
- Define only `app_ids`, `grants`, `confinement`, `restrict`, `risk`, or `approval_tiers` data; never author a `result` rule.
- Map resource identifiers and scopes in `grants` explicitly.
- Add `confinement` or `restrict` overlays only when the narrowing is verified.
- Keep `confinement` and `restrict` deny-only so they never widen authority.
- Add `risk` (scope-to-tier) and `approval_tiers` (gated tiers) only when human approval for high-risk scopes is required; they add a gate, never authority.
- Keep data static, deterministic, and side-effect free.
- Provide representative allow and deny simulation cases.
- Explain the document's effect in simple language when the mapping is not obvious.

Do not use network calls, wall-clock time, random values, runtime filesystem access, or invented fields.
