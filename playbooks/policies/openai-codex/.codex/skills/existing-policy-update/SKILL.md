---
name: existing-policy-update
description: Use to update an existing Caracal Rego policy while preserving current behavior and making the smallest safe change.
---
# Existing Policy Update

## Procedure

1. Read the current policy and identify current allow and deny behavior.
2. Identify the intended behavior change.
3. Identify behavior that must not regress.
4. Verify all input fields against documentation, schemas, sample input, or existing tests.
5. Make the smallest focused change.
6. Provide simulation cases for unchanged behavior, newly allowed behavior, and newly denied behavior.

Preserve the Caracal result contract and deny-by-default behavior.
