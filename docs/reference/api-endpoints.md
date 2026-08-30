<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# API endpoints

REST and GraphQL surface of the Caracal server. Unless noted, endpoints require authentication with a tenant JWT in `Authorization: Bearer <token>`.

Base path: `/api/v1`.

## Auth

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/auth/bootstrap` | Auto-create the first operator on a fresh server (localhost only) |
| `POST` | `/auth/register` | Self-registration (email + password; `deployment.sso_only=false` only) |
| `GET` | `/auth/whoami` | Current user info |
| `PUT` | `/auth/profile/username` | Update the current user's username |
| `PUT` | `/auth/profile/avatar` | Upload the current user's avatar |
| `DELETE` | `/auth/profile/avatar` | Remove the current user's avatar |
| `POST` | `/auth/request-reset` | Request password reset (code logged to server console) |
| `POST` | `/auth/reset-password` | Reset password with code + new password |
| `GET` | `/auth/oauth/login` | Initiate OAuth SSO flow |
| `GET` | `/auth/oauth/callback` | OAuth callback handler |

## Registry

Per type: `mcps`, `agents`, `skills`, `hooks`, `prompts`, `sandboxes`.

All `{id}` parameters accept a UUID or a name.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/{type}` | Submit / create |
| `GET` | `/{type}` | List approved items |
| `GET` | `/{type}/{id}` | Get details |
| `POST` | `/{type}/{id}/install` | Get harness config snippet |
| `DELETE` | `/{type}/{id}` | Delete |
| `GET` | `/{type}/{id}/metrics` | Metrics |
| `POST` | `/agents/{id}/pull` | Pull agent (installs all components) |

### Scan

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/scan` | Bulk register items from harness config scan |

### Review

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/review` | List pending submissions |
| `GET` | `/review/{id}` | Submission details |
| `POST` | `/review/{id}/approve` | Approve |
| `POST` | `/review/{id}/reject` | Reject |

## Telemetry

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/telemetry/events` | Legacy event ingestion |
| `GET` | `/telemetry/status` | Data flow status |
| `POST` | `/ingest/session` | Idempotently ingest indexed session source records and return the highest contiguous acknowledgement |
| `GET` | `/ingest/session/checkpoint` | Get the caller's contiguous line/byte checkpoint for a harness session |

Session record identity is scoped by project, user, harness, session ID, and source line index. Retrying the same content at the same index is safe; different content at an already acknowledged index returns `409`.

Final session requests can include `session_hash` and `hashed_line_count`. The response includes `integrity_ok`, `server_hash`, and `repair_from_line`. A failed audit rewinds the durable checkpoint to the first affected range; the exporter then replays that range idempotently. Hashing and canonical manifest scans occur only for final/audit requests, not incremental ingest.

## Telemetry hooks

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/telemetry/hooks` | Ingest lifecycle hook events (used by Kiro shell hooks) |

## Alerts

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/alerts` | List alert rules |
| `POST` | `/alerts` | Create alert rule |
| `PATCH` | `/alerts/{id}` | Update alert rule |
| `DELETE` | `/alerts/{id}` | Delete alert rule |
| `GET` | `/alerts/{id}/history` | Alert firing history |
## Operator and tenant administration

Deployment operation uses `/operator/*` routes and requires an operator JWT context with the `operator` role. Organization and Project administration uses `/orgs/*` routes and is governed by Organization and Project membership.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/operator/settings` | List settings |
| `PUT` | `/operator/settings/{key}` | Set a value |
| `GET` | `/operator/users` | List users |
| `PUT` | `/operator/users/{id}/role` | Change deployment role |
| `GET` | `/operator/audit-log` | Query audit events |
| `GET` | `/operator/security-events` | Query security events |
| `GET` | `/orgs` | List caller's Organizations |
| `GET` | `/orgs/{org}/projects` | List accessible Projects |

## GraphQL

Single endpoint, query + subscription via WebSocket.

| Path | Description |
| --- | --- |
| `/api/v1/graphql` | Session update subscriptions |

Subscriptions use `graphql-ws` protocol.

## Health

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Readiness - checks DB + ClickHouse |
| `GET` | `/healthz` | Liveness - is the API process alive |

## Rate limiting

Auth endpoints are subject to `RATE_LIMIT_AUTH` and `RATE_LIMIT_AUTH_STRICT`. Non-auth endpoints are not rate-limited by default; put a reverse proxy or API gateway in front if you need it.

## Request size limits

`MAX_REQUEST_SIZE_MB` (default `10`) caps body size on all endpoints. Large telemetry batches may need tuning.

## Related

* [Authentication and SSO](../self-hosting/authentication.md)
* [Hooks specification](hooks-spec.md)
