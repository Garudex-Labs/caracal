# infra

## Scope

- Covers infrastructure assets under `infra/`.

## Architecture Design

- `docker/` owns local and runtime Compose orchestration.
- `helm/` owns the Kubernetes chart and its render validation harness.
- `tofu/` owns OpenTofu provisioning: the Kubernetes stack module, the VM host module, and per-environment roots.
- `postgres/` owns the database image, migrations, and verification scripts.
- `redis/` owns Redis configuration and stream provisioning.
- `healthcheck/` owns the reusable Go healthcheck binary used by service images.
- `secrets/` owns local secret-file generation.
- `scripts/` owns operator probes and the backup/restore lifecycle for the compose stack.

## Required

- Must keep each infrastructure concern in its own subdirectory.
- Must keep runtime, local-development, secret, schema, and probe concerns separated.
- Must keep host ports consistent with the Compose files and product-isolation rules.

## Forbidden

- Must not place service business logic or reusable SDK code in this directory.
- Must not commit generated secret files, backups, cache output, or database dumps.
- Must not duplicate configuration already owned by a service or package manifest.

## Validation

- Validate touched infrastructure with the owning script or Compose command for that subdirectory.
