---
description: Apply when adding, editing, or reviewing deployment artifacts, Docker Compose files, or runtime config.
applyTo: deploy/**
---

## Purpose
Container-first deployment assets for the Caracal runtime stack: Compose files, Dockerfiles, and example config.

## Rules
- `docker-compose.yml` is the canonical local build stack; `docker-compose.image.yml` is pull-and-run only.
- Dockerfiles live in `docker/`; one Dockerfile per service role.
- `config/config.example.yaml` is the reference config for OSS deployments; keep it minimal and valid.
- All environment variables referenced in Compose files must be declared in the example config.
- Runtime state paths must use `$CCL_HOME`; no hardcoded absolute paths.

## Constraints
- Forbidden: committing secrets or real credentials in any deploy file.
- Forbidden: adding new Compose services without a corresponding Dockerfile in `docker/`.
- Forbidden: modifying `config.example.yaml` to require enterprise-only fields.
- File names: `Dockerfile.<role>` in `docker/`; `docker-compose.<variant>.yml` in `deploy/`.

## Security
- All service containers must run as non-root users.
- TLS must be enabled for all inter-service communication in staging and production compose variants.
