# caracal/docker

## Scope
- Covers only the OSS Docker Compose orchestration under `caracal/infra/docker/`.

## Required
- Must use Docker Compose v2 with multi-stage Dockerfiles authored in each service directory.
- Must respect the reserved port table in `caracal/plan/README-plan-system.md`: 3000, 4000, 5432, 6379, 8080, 8081, 9090 (OSS).
- Must declare a healthcheck for every long-running service.
- Must use `depends_on: { service_healthy }` for ordering against postgres and redis.
- Must run the `init` job exactly once per `up` to provision Redis streams.
- Must source secrets from `.env` (dev only); production secrets must come from an external secret manager.

## Forbidden
- Must not import or reference `caracalEnterprise/`.
- Must not bind the same host port twice across services.
- Must not run any container as root.
- Must not bake secrets into images.
- Must not add services beyond the parent plan's service list.
