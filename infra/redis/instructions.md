# caracal/redis

## Scope
- Covers only the Redis 8 configuration and stream provisioning under `caracal/infra/redis/`.

## Required
- Must use Redis 8 only.
- Must listen on port 6379 only.
- Must apply `requirepass` via the `REDIS_PASSWORD` env var passed to `redis-server` on the CLI.
- Must run `provision-streams.sh` once at compose `init` time; the script must remain idempotent.
- Must keep `appendonly yes`, `appendfsync everysec`, and `maxmemory-policy noeviction`.
- Must keep these streams and consumer groups: `caracal.audit.events` (`audit-ingestor`, `siem-export`), `caracal.audit.events.dlq` (`audit-dlq-observer`), `caracal.policy.invalidate` (`opa-engine`), `caracal.sessions.revoke` (`sts-revocation`), `caracal.agents.lifecycle` (`coordinator-relay`), `caracal.providers.ratelimit` (no group).

## Forbidden
- Must not import or reference `caracalEnterprise/`.
- Must not enable Redis modules.
- Must not allow eviction on stream keys.
- Must not store plaintext claims, tokens, or credentials in any payload.
- Must not add streams or consumer groups beyond the list above without first updating the parent plan.
