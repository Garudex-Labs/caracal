<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Data & Retention Settings

Control deployment-wide telemetry retention and how aggressively expensive API responses are cached.

## Purge Traces and Insights {#purge-traces-and-insights}

The **Purge Traces & Insights** danger-zone action permanently deletes telemetry and generated insight data for the deployment.

It removes:

- ClickHouse session events and session aggregates for project `default`.
- Agent insight reports and insight caches/facets for all agents.

It does **not** delete registry agents, versions, skills, hooks, prompts, users, reviews, or audit/security logs.

Use this only when you intentionally need a clean telemetry slate, for example before handing over a demo instance or after importing accidental/private trace data. The action cannot be undone from Caracal; take database backups first if you may need the data later.

## Application retention policy {#application-retention}

The admin retention controls store deployment-wide policy values in the following settings:

| Setting | Effect |
|---------|--------|
| `retention.enabled` | Enables scheduled application-level purging |
| `retention.trace_days` | Deletes session events older than this many days |
| `retention.score_days` | Deletes completed and stale insight reports older than this many days |
| `retention.max_trace_count` | Limits the number of retained sessions |

The policy values are independent of registry ownership. Leave a threshold empty when that limit is not needed. If `retention.score_days` is empty, the purge uses twice `retention.trace_days`, with a 30-day minimum.

## Resource deletion retention {#resource-deletion-retention}

Deleted agents enter a recoverable state before permanent deletion. Each project has its own resource deletion policy:

| Scope | Allowed retention | Effect |
|-------|-------------------|--------|
| Private resources | 0-90 days | A value of 0 makes private deleted agents eligible for automatic cleanup immediately. |
| Project resources | 7-180 days | Shared project resources always keep at least seven days of recovery time. |

The policy is configured in **Settings -> Preferences** for the active project and is enforced server-side. Project leads and organization owners/admins can change it; ordinary project users can read the policy but cannot change it.

When a policy reduction would move existing deleted agents to an earlier permanent-deletion date, the API returns the affected agents and requires explicit confirmation before applying the new policy. Applying a policy never performs the hard delete in the same request; the scheduled cleanup job deletes expired agents separately.

Permanent deletion of a deleted agent can also be requested explicitly by an authorized user. It requires typed confirmation and removes the agent row together with database-backed versions, component links, download records, insights, review issues, and inbox subjects associated with that agent.

## ClickHouse TTL {#data-retention}

`data.retention_days` remains the separate ClickHouse TTL setting. It controls automatic expiry of raw session content and defaults to 90 days. Application retention values cannot exceed this ceiling when it is enabled.

| Value | Effect |
|-------|--------|
| `90` (default) | Keep raw telemetry for 90 days |
| `30` | Short TTL for privacy-sensitive deployments |
| `365` | Long TTL for annual analysis |
| `0` | Keep raw telemetry indefinitely, not recommended unless storage is actively managed |

**When to lower:** The deployment has strict data minimization rules, or ClickHouse storage is growing too quickly.

**When to raise:** You need longer trend windows for audits, investigations, or longitudinal agent performance analysis.

## Default Cache TTL {#default-cache-ttl}

Default cache duration, in seconds, for ordinary API responses.

| Value | Effect |
|-------|--------|
| `30` (default) | Good balance between freshness and database load |
| `5` | Very fresh data, higher database pressure |
| `120` | Lower database load, more stale list/detail pages |

## Dashboard Cache TTL {#dashboard-cache-ttl}

Cache duration, in seconds, for expensive dashboard aggregation queries.

| Value | Effect |
|-------|--------|
| `60` (default) | Dashboards feel fresh without hammering ClickHouse |
| `15` | Near-live dashboard updates, higher query load |
| `300` | Lower query load for large deployments, charts can lag by several minutes |

## OTEL Cache TTL {#otel-cache-ttl}

Cache duration, in seconds, for trace and session list endpoints.

| Value | Effect |
|-------|--------|
| `15` (default) | Keeps trace lists responsive while preserving near-live monitoring |
| `5` | Useful during active debugging |
| `60` | Better for large deployments where trace lists are expensive |
