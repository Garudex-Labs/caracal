---
name: input-validation
description: Use to validate Caracal policy input fields, schemas, sample inputs, and assumptions before using them in a Rego policy.
---
# Input Validation

## Procedure

1. Check Caracal documentation and policy schemas for available fields.
2. Compare the requirement with supplied sample input.
3. Verify resource identifier, scopes, principal, application, context, session, grant, and delegation fields.
4. Mark undocumented or missing fields as unknown.
5. Ask for clarification instead of inventing fields.

Only documented or supplied fields may appear in policy logic.
