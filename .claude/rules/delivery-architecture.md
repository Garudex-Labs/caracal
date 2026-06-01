---
description: "Use when designing packaging, deployment, distribution, feature flags, shared components, or delivery workflows in caracal or caracalEnterprise. Enforces dev/prod separation, centralized shared layers, controlled rollout, and simple secure maintainable delivery practices."
applyTo: "caracal/**, caracalEnterprise/**"
---

# Delivery And Architecture

- Separate development and production behavior through explicit configuration, build targets, secrets handling, and deployment paths.
- Must not mix development tooling, debug behavior, mock integrations, or test-only dependencies into production artifacts or runtime paths.
- Use feature flags for incomplete, risky, or staged functionality so rollout and rollback stay controlled without branching the codebase.
- Keep feature flag evaluation, defaults, and lifecycle management centralized instead of scattering ad hoc checks through the codebase.
- Centralize shared components such as configuration, error models, utilities, and cross-cutting helpers within a single approved layer per product.
- Must not duplicate shared logic across packages, apps, or services when a current in-product shared layer already owns that concern.
- Keep packaging, deployment, and distribution flows reproducible, minimal, and automation-friendly.
- Choose designs that improve security, performance, and maintainability without adding unnecessary steps, tools, or local setup burden to the developer workflow.