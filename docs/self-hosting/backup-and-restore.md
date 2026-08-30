<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Backup and restore

What to back up, how often, and how to restore. Caracal has two persistent stores that matter and a handful of rebuildable ones.

## What matters, in order

| Priority | Volume | Contents | Loss impact |
| --- | --- | --- | --- |
| **Critical** | `pgdata` | Users, RBAC, registry metadata, agents, JWT signing keys | All accounts and registry lost; every session invalidated. |
| **Important** | `chdata` | Session events, aggregates, audit, and security events | All telemetry lost. Accounts and registry survive. |
| **Low** | `grafanadata` | Custom Grafana dashboards | Custom dashboards lost; provisioned defaults come back automatically. |
| **Low** | `redisdata` | Cache, pub/sub, and token-revocation state | Rebuilt automatically on restart. |
| **Low** | `serverdata` | In-flight migration-export artifacts on `caracal-server` | Re-run the export. |

**`pgdata` carries both the accounts and the JWT signing keys.** A Postgres backup is also your session-continuity backup; there is no separate key volume to manage.

## Backup cadence

| Cadence | What | Retention |
| --- | --- | --- |
| Daily | `pgdata` | 30 days |
| Weekly | `chdata` | 12 weeks |
| Before every upgrade | Both | Keep until the upgrade is confirmed stable |

## Postgres backup

Use `pg_dump` inside the running container:

```bash
docker compose -f infra/docker/docker-compose.yml exec -T caracal-db \
  pg_dump -U postgres caracal | gzip > caracal-pg-$(date +%Y%m%d).sql.gz
```

Restore into a fresh DB:

```bash
docker compose -f infra/docker/docker-compose.yml down -v
docker compose -f infra/docker/docker-compose.yml up -d caracal-db

zcat caracal-pg-20260421.sql.gz | \
  docker compose -f infra/docker/docker-compose.yml exec -T caracal-db \
  psql -U postgres caracal

docker compose -f infra/docker/docker-compose.yml up -d
```

The JWT signing keys live in Postgres alongside the accounts, so a restored `pgdata` keeps existing sessions valid - no separate key restore step.

## ClickHouse backup

### Option A - volume snapshot (simplest)

```bash
docker compose -f infra/docker/docker-compose.yml stop caracal-clickhouse
docker run --rm -v caracal_chdata:/data -v "$(pwd)":/backup \
  alpine tar czf /backup/caracal-ch-$(date +%Y%m%d).tar.gz -C /data .
docker compose -f infra/docker/docker-compose.yml start caracal-clickhouse
```

Downtime: however long the tar takes (a minute to tens of minutes depending on size).

### Option B - ClickHouse native `BACKUP` (no downtime)

```bash
docker compose -f infra/docker/docker-compose.yml exec caracal-clickhouse \
  clickhouse-client --query "BACKUP DATABASE caracal TO Disk('backups', 'caracal-$(date +%Y%m%d).zip')"
```

Requires configuring a backup disk in ClickHouse config; see [ClickHouse docs](https://clickhouse.com/docs/en/operations/backup).

Restore:

```bash
docker compose -f infra/docker/docker-compose.yml exec caracal-clickhouse \
  clickhouse-client --query "RESTORE DATABASE caracal FROM Disk('backups', 'caracal-20260421.zip')"
```

## Restore order

If you're restoring from backup after a catastrophic failure:

1. Stop the whole stack: `docker compose down`.
2. Restore `pgdata` (Postgres) first - it carries accounts and JWT signing keys.
3. Restore `chdata` (ClickHouse).
4. Bring up the stack: `docker compose up -d`.
5. Smoke test: `caracal auth login`, `caracal auth status`.

## Verifying a backup

Test restores in a staging environment at least quarterly. Untested backups are guesses.

Smoke test after restore:

```bash
caracal auth login
caracal auth whoami              # you should be your pre-backup user
caracal agent list               # registry should be intact
caracal ops traces --limit 5     # traces up to the backup timestamp should be visible
```

## Automated backup

A minimal cron setup (on the Docker host):

```cron
# Daily at 03:00 - Postgres (accounts + JWT signing keys)
0 3 * * * cd /opt/Caracal && \
  docker compose -f infra/docker/docker-compose.yml exec -T caracal-db \
  pg_dump -U postgres caracal | gzip > /backups/pg-$(date +\%Y\%m\%d).sql.gz

# Weekly Sunday at 04:00 - ClickHouse
0 4 * * 0 cd /opt/Caracal && \
  docker compose -f infra/docker/docker-compose.yml stop caracal-clickhouse && \
  docker run --rm -v caracal_chdata:/data -v /backups:/backup alpine \
    tar czf /backup/ch-$(date +\%Y\%m\%d).tar.gz -C /data . && \
  docker compose -f infra/docker/docker-compose.yml start caracal-clickhouse
```

Ship the `/backups` directory offsite (S3, B2, rsync to another host).

## Next

→ [Troubleshooting](troubleshooting.md)
