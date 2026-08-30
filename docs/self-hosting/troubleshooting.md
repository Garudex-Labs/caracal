<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Troubleshooting

Common failure modes and their fixes. If none of these match, open a [GitHub Discussion](https://github.com/Garudex-Labs/caracal/discussions) with the output of `caracal auth status` and relevant logs from `docker compose logs`.

## Install and CLI

### `"Connection failed. Is the server running?"`

The CLI cannot reach the API. Check:

```bash
docker compose -f infra/docker/docker-compose.yml ps     # API status
curl http://localhost/health                       # API health
caracal config show                               # is server_url right?
```

If `server_url` is wrong:

```bash
caracal config set server_url http://localhost
caracal auth login
```

### `"System already initialized"` when logging in

The server already has users, so bootstrap is disabled. Use `caracal auth login` with an email + password or an API key, not a fresh bootstrap flow.

## Docker and networking

### `port is already allocated`

Another process is on one of Caracal's default ports. Remap host ports:

```bash
POSTGRES_HOST_PORT=5433 REDIS_HOST_PORT=6380 \
  docker compose -f infra/docker/docker-compose.yml up --build -d
```

Full list in [Ports and volumes](ports-and-volumes.md).

### Service stuck in `starting`

The API depends on Postgres, ClickHouse, and Redis being healthy. Check each:

```bash
docker compose -f infra/docker/docker-compose.yml ps
docker compose -f infra/docker/docker-compose.yml logs caracal-db
docker compose -f infra/docker/docker-compose.yml logs caracal-clickhouse
docker compose -f infra/docker/docker-compose.yml logs caracal-redis
```

Common causes:

* ClickHouse stuck during initial `CREATE TABLE`. Restart it once the healthcheck passes on other DBs
* `CLICKHOUSE_PASSWORD` mismatch between services and API config

### Services restart in a loop

Check logs (`docker compose logs -f <service>`). Three frequent causes:

* Memory limit too tight. Bump limits in `docker-compose.yml`
* Corrupt volume. Wipe and restore from backup
* Config error introduced during an upgrade. Roll back

## Auth

### Admin forgot password

```bash
caracal auth reset-password --email admin@your-company.com
```

Then read the reset code from the server log:

```bash
docker logs caracal-api 2>&1 | grep "PASSWORD RESET CODE"
```

Enter the code when the CLI prompts.

### OAuth login fails with `redirect_uri_mismatch`

The IdP doesn't have the right redirect URI registered. Add:

```
{FRONTEND_URL}/api/v1/auth/oauth/callback
```

with `FRONTEND_URL` set to your real external URL (scheme and host must match exactly).

### All users logged out after restart

Likely the `apidata` volume was recreated, so the JWT signing keys are new. Restore the `apidata` volume from backup, or accept that all sessions are invalid and everyone has to log in again.

## Telemetry

### Nothing in the dashboard

Run through, in order:

```bash
# 1. Are sessions arriving at all?
caracal ops telemetry status

# 2. Are session hooks installed for the harness?
caracal doctor --output json

# 3. Is the API reachable from the harness environment?
curl http://localhost/health
```

If hooks are missing, run `caracal doctor patch --harness <harness>`. If sessions still are not arriving, check `~/.caracal/telemetry_buffer.db`; growth indicates pending session delivery rather than silent loss.

### ClickHouse not receiving data

Check the `CLICKHOUSE_URL` the API is using:

```bash
docker compose -f infra/docker/docker-compose.yml exec caracal-api \
  printenv CLICKHOUSE_URL
```

The source Compose default is `clickhouse://default:clickhouse@caracal-clickhouse:8123/caracal`. Mismatches typically happen after changing `CLICKHOUSE_PASSWORD` without updating the URL.

Server-package installs use `CLICKHOUSE_URL_FILE=/run/secrets/clickhouse_url`, a hashed ClickHouse user configuration, and a separate health-check password file. Confirm the file is mounted without printing it:

```bash
docker compose exec caracal-api test -r /run/secrets/clickhouse_url
docker compose exec caracal-clickhouse test -r /run/secrets/clickhouse_password
```

Verify ClickHouse itself:

```bash
docker compose -f infra/docker/docker-compose.yml exec caracal-clickhouse \
  clickhouse-client --query "SELECT count() FROM caracal.session_events"
```

## Web UI

### Blank white page

Frontend is still building. Check:

```bash
docker compose -f infra/docker/docker-compose.yml logs -f caracal-web
```

For local dev (running Vite outside Docker), verify `VITE_API_URL` in `apps/web/.env.local` matches your backend.

### Login redirects back to login immediately

Browser cookies aren't being set. Usually one of:

* `FRONTEND_URL` doesn't match the URL you're hitting.
* `CORS_ALLOWED_ORIGINS` doesn't include your frontend origin.
* You're on HTTP behind a proxy that's setting `secure` cookies. Terminate TLS at your proxy and keep `FRONTEND_URL=https://...`.

## Where to get more help

* Logs: `docker compose -f infra/docker/docker-compose.yml logs -f`
* Health: `curl http://localhost/health`
* Status: `caracal auth status`
* Community: [GitHub Discussions](https://github.com/Garudex-Labs/caracal/discussions)
* Bugs: [GitHub Issues](https://github.com/Garudex-Labs/caracal/issues). Please use Discussions for questions, Issues only for confirmed bugs
