<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configuration

Boot-time infrastructure settings live in `.env`. Credentials can use dedicated files. Runtime settings, including SSO, normally live in the admin UI, while file-backed sensitive settings remain only in process memory.

## Required for production

Source deployments must override these before going live. Server-package setup generates the secret values and file references automatically:

| Variable               | Default                        | Why change                                                                                                                         |
| ---------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `SECRET_KEY` or `SECRET_KEY_FILE` | `change-me-to-a-random-string` | Application encryption secret. Use a random value of at least 32 characters. |
| `POSTGRES_PASSWORD` or `POSTGRES_PASSWORD_FILE` | `postgres` | PostgreSQL bootstrap credential. |
| `CLICKHOUSE_PASSWORD` or generated hashed user config | `clickhouse` | ClickHouse credential. |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:8000`        | Scope to your real frontend origin(s). Configure as `deployment.cors_origins` in Admin Settings.                                   |
| `deployment.frontend_url` | `http://localhost:8000`     | Used for OAuth redirects and email links. Configure in Admin Settings.                                                             |

The server-package installer generates these credentials in an operator-owned `secrets/` directory. Directories use mode `0750`, files use mode `0640`, and `CARACAL_SECRET_GID` grants the containers read access through the operator's group. Existing deployments can keep direct environment values.

With a terminal, setup prompts for the frontend URL, bind address, and observability profile. Without a terminal, the same installer selects `http://localhost:3000`, loopback binding, and no optional observability stack. It prints the initial super-admin email, generated password, and password-file path after the first successful startup. Existing headless installations preserve their configuration rather than replacing it.

## Secret files

For any supported credential named `NAME`, set `NAME_FILE` to a UTF-8 file path instead of placing the value in `.env`:

```dotenv
SECRET_KEY_FILE=/run/secrets/secret_key
DATABASE_URL_FILE=/run/secrets/database_url
JWT_KEY_PASSWORD_FILE=/run/secrets/jwt_key_password
GIT_CLONE_TOKEN_FILE=/run/secrets/git_clone_token
OAUTH_CLIENT_SECRET_FILE=/run/secrets/oauth_client_secret
INSIGHTS_API_KEY_FILE=/run/secrets/insights_api_key
```

The reader accepts files up to 64 KiB and removes one trailing newline. Setting both `NAME` and `NAME_FILE` is an error, so precedence is never ambiguous. Replace a file atomically and restart the affected API or worker processes to rotate the value without rebuilding Caracal.

File-backed dynamic settings are marked externally managed in the admin API. Their contents are not imported into PostgreSQL or Redis, and the admin API rejects attempts to overwrite, delete, or revoke them.

Supported file-backed boot credentials include `DATABASE_URL`, `CLICKHOUSE_URL`, `REDIS_URL`, `SECRET_KEY`, `OLD_SECRET_KEY`, `JWT_KEY_PASSWORD`, and `GIT_CLONE_TOKEN`. SSO environment imports support the same form, including OAuth client secrets, Google and GitHub OAuth secrets, the insights provider key, SAML certificates, and the SAML key-encryption password. CLI tokens support `CARACAL_ACCESS_TOKEN_FILE` and `CARACAL_TOKEN_FILE`.

PostgreSQL containers use `POSTGRES_PASSWORD_FILE`. The server package generates a hashed ClickHouse user configuration instead of putting its database password in `.env`. Service-specific subdirectories expose only the PostgreSQL password to PostgreSQL, the ClickHouse health credential to ClickHouse, and the Grafana and ClickHouse datasource credentials to Grafana.

## SSO-only mode

Set `deployment.sso_only=true` in **Admin → SSO** when you want IdP-only access. Leave it `false` to keep password login available.


## Development-only login

For local development the identity service can expose a development login route. It is double-gated server-side: the route exists only when the auth container runs with `NODE_ENV` other than `production` **and** `AUTH_DEV_LOGIN=1`. A production `NODE_ENV` disables it no matter what `AUTH_DEV_LOGIN` says. Never set these variables in a real deployment.

```dotenv
# local development only
AUTH_NODE_ENV=development
AUTH_DEV_LOGIN=1
```

> **Admin settings warning:** If `SECRET_KEY` is insecure, the **Settings → General** instance page will display a warning banner at the top so operators can spot and fix the issue without digging through logs.

## Database connections

Source deployments may use direct values:

```dotenv
DATABASE_URL=postgresql+asyncpg://postgres:postgres@caracal-db:5432/caracal
CLICKHOUSE_URL=clickhouse://default:clickhouse@caracal-clickhouse:8123/caracal
REDIS_URL=redis://caracal-redis:6379
```

Server-package installs use file references instead:

```dotenv
DATABASE_URL_FILE=/run/secrets/database_url
CLICKHOUSE_URL_FILE=/run/secrets/clickhouse_url
REDIS_URL_FILE=/run/secrets/redis_url
```

Inside Docker Compose, hostnames resolve via the `caracal-net` bridge (e.g. `caracal-db`). Outside Docker (e.g. CLI running on host against dockerized DBs), use `localhost:<port>`.

## OAuth / SSO

Optional. Configure OIDC, SAML, and SSO-only mode in **Admin → SSO**. OIDC client changes are stored immediately, then take effect after the API restarts.

Full setup in [Authentication and SSO](authentication.md).

## Rate limiting

```
RATE_LIMIT_AUTH=10/minute          # general auth endpoints
RATE_LIMIT_AUTH_STRICT=5/minute    # login and password reset
```

Tighten for higher-traffic deployments.

## ClickHouse retention

```
DATA_RETENTION_DAYS=90
```

Session events older than this are removed from ClickHouse. Set to `0` to disable retention. The minimum non-zero value enforced on startup is 7.

## JWT keys

```
JWT_SIGNING_ALGORITHM=ES256        # ES256 (default) or RS256
JWT_KEY_DIR=/data/keys             # persisted in the apidata volume
```

The server generates asymmetric keys on first boot and stores them in `$JWT_KEY_DIR`. **Back up this directory**: losing the keys invalidates every session. Changing `JWT_SIGNING_ALGORITHM` and restarting retires the current public key, generates the selected key type, and keeps old tokens verifiable during their normal lifetime.

SAML service-provider material can be mounted independently:

```dotenv
SAML_SP_PRIVATE_KEY_FILE=/run/secrets/saml_sp_private_key
SAML_SP_X509_CERT_FILE=/run/secrets/saml_sp_x509_cert
```

Set both files together. They override database-generated SP material, are reported as externally managed, and cannot be regenerated or removed through the admin API. Replace both files and restart the API to rotate them.

More: [Authentication and SSO](authentication.md).

## Git operations (submission analysis)

```dotenv
ALLOW_INTERNAL_URLS=false          # allow internal/private Git URLs (GitLab/GHE)
GIT_CLONE_TOKEN_FILE=/run/secrets/git_clone_token
GIT_CLONE_TOKEN_USER=x-access-token
GIT_CLONE_TIMEOUT=120              # seconds
```

`GIT_CLONE_TOKEN_USER` varies by provider: `x-access-token` for GitHub, `oauth2` or `private-token` for GitLab.

## Caracal CLI (client-side) env vars

Not set in `.env` on the server. These live on the CLI user's machine.

| Variable                                     | Purpose                          |
| -------------------------------------------- | -------------------------------- |
| `CARACAL_SERVER_URL`                        | Default server URL               |
| `CARACAL_ACCESS_TOKEN` | Pre-authenticate without `login` |
| `CARACAL_TIMEOUT`                           | Request timeout (seconds)        |

Full list: [Environment variables](../reference/environment-variables.md).

## Next

→ [Ports and volumes](ports-and-volumes.md)
