# caracal/docker

## Scope
- Covers only the OSS Docker Compose orchestration under `caracal/infra/docker/`.

## Required
- Must use Docker Compose v2 with multi-stage Dockerfiles authored in each service directory.
- Must respect the reserved port table in `caracal/plan/README-plan-system.md`: 3000, 4000, 5432, 6379, 8080, 8081, 9090 (OSS).
- Must declare a healthcheck for every long-running service.
- Must use `depends_on: { service_healthy }` for ordering against postgres and redis.
- Must run the `dbMigrate` one-shot before any application service starts; every app service must declare `dbMigrate: { condition: service_completed_successfully }`.
- Must keep Redis stream provisioning inside the redis container's entrypoint so it is idempotent and re-runs on every boot.
- Must source secrets from `.env` (dev only); production secrets must come from an external secret manager.
- Must tag locally-built images as `localhost/caracal-{svc}:dev-${CARACAL_DEV_SHA}`; must not use floating `:dev` tags or `ghcr.io/...` references in the dev compose file.
- Must propagate `CARACAL_MODE` to every app service so Go and Node services can enforce `AssertRuntimeSafe`.

## Forbidden
- Must not import or reference `caracalEnterprise/`.
- Must not bind the same host port twice across services.
- Must not run any container as root.
- Must not bake secrets into images.
- Must not add services beyond the parent plan's service list.
