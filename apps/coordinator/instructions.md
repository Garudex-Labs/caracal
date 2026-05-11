# coordinator

## Scope
- Covers the coordinator app under caracal/apps/coordinator/ only.

## Required
- Must use TypeScript on Node 24 (coordinator core, port 4000) and Go 1.26 (relay, no port).
- Must listen on port 4000 only (coordinator).
- Must enforce hard limits: depth ≤ 10, children ≤ 10, total agents ≤ 50 per zone, ≤ 200 per application.
- Must cascade-terminate all descendants on terminate, TTL expiry, and delegation revoke that targets a session.
- Must cascade suspend and resume across active/suspended descendants.
- Must enqueue every lifecycle, revocation, invocation, and delegation event to caracal_outbox; never xadd directly.
- Must serialize agent spawn caps, terminate cascades, and delegation graph mutations with pg_advisory_xact_lock per zone.
- Must guard background sweeps with pg_try_advisory_xact_lock for leader election and bound each tick by SWEEPER_BATCH_SIZE.
- Must transition deadline-overdue invocations to failed when attempts < max_attempts and to timed_out otherwise; clients must not submit timed_out via complete.
- Must verify issuer ownership (or coordinator.delegate_from / coordinator.admin) before revoking a delegation edge.
- Must verify caller owns the source application (or holds coordinator.invoke_from / coordinator.admin) before creating an invocation.
- Must bump delegation_graph_epochs on every delegation create or revoke and include the epoch in the invalidation event.
- Must publish to Redis Streams with MAXLEN ~ STREAMS_MAXLEN for bounded retention.
- Must rate-limit /v1/verify per client IP via Redis when VERIFY_RATE_LIMIT_PER_MIN > 0; /v1/verify is intentionally unauthenticated and language-neutral.
- Must dedupe relay-side delivery on outbox_id within RELAY_DEDUPE_WINDOW_SEC; outbox→stream is at-least-once.
- Must use github.com/garudex-labs/caracal/core/* for Go relay config and logging.

## Forbidden
- Must not import from caracalEnterprise/.
- Must not allow soft-bypass of agent limits.
- Must not store plaintext claims or credentials.
- Must not bypass the outbox by calling redis.xadd from request handlers or sweepers.
- Must not authorize heartbeat or revoke after mutating state; check ownership first.
- Must not run unbounded UPDATE ... RETURNING in sweepers.
