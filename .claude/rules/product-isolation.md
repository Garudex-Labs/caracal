---
description: "Use when working in caracal or caracalEnterprise. Enforces strict isolation between the open-source and enterprise codebases, including imports, dependencies, shared logic, and license boundaries."
applyTo: "caracal/**, caracalEnterprise/**"
---

# Product Isolation

- Treat `caracal/` and `caracalEnterprise/` as separate products with a hard architectural boundary.
- Must not import, require, reference, or load source files across the `caracal/` and `caracalEnterprise/` roots.
- Must not add workspace, package-manager, build, or generated-artifact links that make one product depend on the other.
- Must not copy, mirror, or move implementation code from one product into the other as a shortcut for reuse.
- Shared behavior must only cross the boundary through explicitly approved, license-compliant interfaces.
- If an approved interface does not already exist, stop and ask for the sanctioned interface location or contract before implementing cross-product reuse.
- Keep tests, fixtures, generated files, and documentation references isolated to the product they belong to unless an approved interface explicitly requires otherwise.
- When parallel changes are needed in both products, implement them independently on each side of the boundary.
- Enforce separate local ports for all OSS and enterprise services. Localhost ports used by `caracal/` services must not be reused by `caracalEnterprise/` services in code, config, Docker files, examples, or documentation.
- When introducing or changing a local service port, keep the assignment explicit and non-overlapping across the workspace so local OSS and enterprise stacks can run side by side.