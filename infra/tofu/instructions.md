# infra/tofu

## Scope

- Covers OpenTofu infrastructure provisioning for Caracal Kubernetes deployments under `infra/tofu/`.

## Architecture Design

- `modules/caracalStack/` is the single reusable unit: a pod-security-restricted namespace, optional externally managed runtime Secret, and the Caracal Helm release.
- `envs/dev/` installs the working-tree chart with the chart's `values.dev.yaml`; `envs/production/` installs a pinned OCI-published chart version with the chart's `values.production.yaml`.
- Chart profile values files remain the single source of deployment defaults; environment roots reference them with `file()` instead of duplicating their content.
- Cluster access is provider-injected and kubeconfig-based by default so roots stay portable across EKS, GKE, AKS, and self-hosted clusters.

## Required

- Must pin `required_version` for OpenTofu and version constraints for every provider.
- Must keep the module provider-agnostic: providers are configured only in environment roots.
- Must route runtime credentials through the `runtimeSecrets` variable or an external secret manager, never through chart plaintext values.
- Must keep production roots pinned to released chart versions from the OCI registry.
- Must run `bash infra/tofu/scripts/validate.sh` after any change in this tree.

## Forbidden

- Must not commit `terraform.tfvars`, state files, lock data with credentials, or any secret material.
- Must not duplicate chart values profiles into HCL; reference the chart's values files instead.
- Must not add cloud-provider-specific resources to `modules/caracalStack`; provider-specific concerns live in environment roots or separate modules.

## Validation

- `bash infra/tofu/scripts/validate.sh` runs `tofu fmt -check` and an offline `tofu validate` of every environment root.
