<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Upgrades

Safe upgrade flow for the Caracal server stack.

## Quick upgrade (recommended)

If you run the Docker stack from the server package, the operator script handles upgrades:

```bash
./ops.sh upgrade --dry-run
./ops.sh upgrade 0.9.0
```

This pulls new Docker images, backs up PostgreSQL, recreates containers, and runs health checks. If the health check fails, it requests the previous image version again. Local shell and Docker access authorize the operation; the script does not require a reachable API or API role.

The operator script ships in the server package as `ops.sh`.

### Server-package upgrades

If you installed with `install-server.sh`, rerun the installer for the target release. Setup detects the existing `.env`. Choose the default **No** response when asked to replace configuration so custom values and existing direct credentials remain unchanged. The upgrade records the prior bind address when an older install has no `CARACAL_BIND_ADDRESS` setting.

Back up `.env`, `secrets/`, and the `apidata` and `pgdata` volumes first. Choosing **Yes** intentionally rebuilds the general configuration from the new template; core application, PostgreSQL, ClickHouse, Grafana, and demo credentials are preserved or migrated into restricted files, but unrelated custom environment entries must be reapplied.

## Before a manual upgrade

1. **Back up `pgdata`** and **`apidata`**. See [Backup and restore](backup-and-restore.md). Backing up `chdata` is nice-to-have; losing telemetry is painful but not catastrophic.
2. **Read the [CHANGELOG](https://github.com/Garudex-Labs/caracal/blob/main/CHANGELOG.md)** for the releases you're jumping across. Note any breaking changes.
3. **Pin the version you're upgrading to**: don't `git pull main` blindly. Check out a release tag or a known-good commit.

## Standard upgrade

```bash
cd caracal

# Fetch and check out the target version
git fetch --tags
git checkout v0.9.1

# Rebuild images
docker compose -f infra/docker/docker-compose.yml pull
docker compose -f infra/docker/docker-compose.yml up --build -d

# Verify
docker compose -f infra/docker/docker-compose.yml ps
curl http://localhost/health
```

The init container applies pending Postgres Alembic migrations and ClickHouse SQL migrations before the API starts. Watch the init logs for migration output:

```bash
docker logs -f caracal-init
# Running database migrations...
# Running ClickHouse migrations...
```

## Zero-downtime upgrade (small teams)

If you run a single instance and have a ~30-second maintenance window:

1. Back up `pgdata`, `apidata`, `chdata`.
2. Stop the API and worker: `docker compose stop caracal-api caracal-worker`.
3. Apply migrations out of band with `alembic upgrade head` and `python -m services.clickhouse.migrations` from `caracal-server`, or run the init container once.
4. Pull/rebuild new images: `docker compose pull && docker compose build caracal-api caracal-worker`.
5. Start: `docker compose up -d`.
6. Smoke test: `caracal auth status --output json && caracal ops telemetry status --output json`.

Web UI, Postgres, ClickHouse, Redis stay up throughout. Users see a brief API outage (~15–30 s).

## Zero-downtime at scale

For blue/green upgrades on large deployments:

1. Run a second stack (`docker-compose.yml` with different project name and host ports) behind a reverse proxy.
2. Apply migrations before traffic cutover. Alembic handles Postgres and `services.clickhouse.migrations` handles ClickHouse. Additive migrations should work with API N-1 and N during the rollout.
3. Bring up the green stack pointing at the same `pgdata` / `chdata` / `apidata` volumes.
4. Flip the reverse proxy to green.
5. Decommission blue.

If a migration is **not** additive (rare, but happens: column drops, type changes), it gets called out in the CHANGELOG and requires a brief outage. Plan the window.

## Rolling back

If the new version breaks:

1. `docker compose -f infra/docker/docker-compose.yml down`
2. `git checkout <previous-version>`
3. `docker compose -f infra/docker/docker-compose.yml up --build -d`

**The catch:** if the failing version already applied a migration, downgrading to the previous API version may leave you running against a schema it doesn't know about. Options:

* **If the migration is additive** (most are): the previous version works fine against the newer schema.
* **If the migration is destructive**: restore from the pre-upgrade `pgdata` backup. This is why the backup is step 1.

## CLI upgrades

CLI upgrades are independent of server upgrades. Users:

```bash
caracal self upgrade
```

The CLI speaks a stable contract with the server. A newer CLI works against an older server and vice versa, within a release or two.

## Zero-downtime for the web UI

The web UI is a static Vite build and restarts instantly. Users see a brief reload if they are on the page during the deploy. No special handling required.

## Next

→ [Backup and restore](backup-and-restore.md)
