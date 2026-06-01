---
description: "Use when updating infrastructure, dependencies, runtimes, build tooling, or platform-facing code in caracal or caracalEnterprise. Enforces latest stable versions and OS-, framework-, and environment-agnostic design through strict abstraction layers and standardized interfaces."
applyTo: "caracal/**, caracalEnterprise/**"
---

# Latest Stable And Portability

- Use the latest stable release for infrastructure components, runtimes, frameworks, libraries, SDKs, CLIs, and build tooling unless the repository already pins a newer approved standard.
- Must not introduce rc, deprecated, end-of-life, or legacy versions without explicit approval.
- Upgrade toward the current stable line when touching dependency or infrastructure configuration unless a documented repository constraint blocks it.
- Keep operating system, framework, cloud, database, and environment specific behavior behind narrow abstraction layers.
- Expose platform-facing behavior only through standardized interfaces with interchangeable implementations.
- Must not spread platform checks, vendor APIs, filesystem assumptions, shell-specific behavior, or framework-specific logic through feature code.
- Default to portable APIs, deterministic configuration, and environment-neutral contracts.
- If a platform-specific dependency or capability is required, isolate it behind a single boundary and document the constraint in the code that owns that boundary.
