---
name: policy-set-activation
description: Use to guide Caracal policy validation, immutable policy versioning, policy-set simulation, activation, audit review, and rollback planning.
---
# Policy Set Activation

## Procedure

1. Validate the policy in Console or through the Admin API.
2. Create an immutable policy version.
3. Add the policy version to a policy-set version.
4. Simulate representative allow and deny inputs.
5. Activate only when simulation matches intended behavior.
6. Review audit and request trace output after first use.
7. Keep the last known-good policy-set version available for rollback.

Policies become effective through active policy-set versions, not by mutating active policy content.
