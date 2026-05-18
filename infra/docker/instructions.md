# infra/docker

## Scope
- Covers Docker and Docker Compose orchestration under `infra/docker/`.

## Architecture Design
- `docker-compose.yml` is the local development stack using local images and repo paths.
- `runtime-compose.yml` is the self-hosted runtime stack using versioned GHCR images.
- Service Dockerfiles remain with their owning service or app unless shared Go-service packaging is required.

## Required
- Must keep CLI-managed local images tagged as `localhost/caracal-*:${CARACAL_DEV_VERSION}` using `<base>-dev.sha<gitsha>`.
- Must keep runtime images pinned to `v${CARACAL_VERSION}` through `CARACAL_REGISTRY`.
- Must keep healthchecks on long-running services and gate startup with `service_healthy` or `service_completed_successfully`.
- Must source secrets through Compose secrets, never inline environment literals.
- Must preserve OSS host ports: 3000, 4000, 5432, 6379, 8080, 8081, 8087, and 9090.

## Forbidden
- Must not use floating release tags for runtime images.
- Must not make local development pull GHCR images.
- Must not run application containers as root or bake secrets into images.
- Must not bind the same host port twice.

## Validation
- Validate Compose edits with `docker compose -f infra/docker/docker-compose.yml config`.
