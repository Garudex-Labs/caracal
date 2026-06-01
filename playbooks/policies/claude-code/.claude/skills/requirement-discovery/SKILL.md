---
name: requirement-discovery
description: Use to discover Caracal policy requirements, actors, resources, scopes, allow cases, deny cases, exceptions, and missing information before writing Rego.
---
# Requirement Discovery

## Procedure

1. Identify the policy category.
2. Identify the protected resource and requested scopes.
3. Identify the actor, application, subject, session, grant, and delegation context.
4. Translate business requirements into explicit allow and deny logic.
5. Identify exceptions, overrides, and fallback behavior.
6. Ask for missing fields, sample policy input, existing policy, or documentation when needed.

Do not write Rego until requirements and inputs are clear.
