# Coordinator performance investigation

## Scope and lifecycle

The Coordinator records governed execution; it does **not** execute agent methods or
proxy resource requests itself. The live benchmark drives workers' create/start/complete
protocol over HTTP, not `Fastify.inject` or fake database clients.

* Every ordinary request passes the global Redis-time-based rate limiter. Lifecycle
  callers then verify an ES256 Session mandate using a bounded per-zone JOSE JWKS
  resolver and perform an uncached PostgreSQL application/authority liveness check.
  Warm requests do not fetch JWKS from STS; revocation is not cached away.
* Session starts bind transaction-local RLS, acquire a per-key receipt lock when used,
  then a zone-wide start/cascade lock, validate references/capacity/parent limits,
  insert topology and inherited authority, enqueue lifecycle events, persist the receipt,
  and commit. Starts, suspend/resume, lease fencing, cascades and caps are unchanged.
* Delegations serialize graph mutations, verify endpoint identity and attenuation,
  reject cycles, update the graph epoch, and enqueue invalidation. Revoke still
  terminates affected Sessions and emits revocation through the outbox.
* Invocations verify the service and Session owners, serialize durable duplicates,
  apply the invocation rate limit only to new operations, and persist the invocation,
  receipt and event atomically. Start/cancel/complete use row locks and conditional
  updates; the existing deadline job handles overdue execution.
* A successful mutation waits for a **second, durable audit transaction** before
  sending headers. Audit failure still reports `audit_unavailable` after the operation
  has committed; an idempotent retry must replay rather than repeat that operation.
* Existing publisher/relay/sweeper jobs remain enabled. Redis Streams carry signed,
  at-least-once outbox events to STS/Gateway consumers. The separate SDK protected
  resource E2E test covers nested Sessions, narrowed delegation, STS minting, Gateway
  enforcement, the real HTTP upstream, and persisted Audit allow events.

## Changes and evidence

Only two production paths change:

1. `packages/adminAudit/ts/src/index.ts`: the existing head query orders a
   `COALESCE(chain_seq, 0)` **output alias**, forcing a retained-history scan/sort under
   the per-zone advisory lock. Read positive heads using the existing
   `(zone_id, chain_seq DESC)` index, ordering the stored column. If none exists,
   use the original query, preserving empty, legacy/null and nonpositive chains.
   The shared helper is touched because Coordinator's success gate uses it; hash
   inputs, HMACs, locks, transactions and the gate are unchanged.
2. `apps/coordinator/src/idempotency.ts`: read receipts after the existing per-key
   lock and evaluate expiry using PostgreSQL's transaction clock. New keys and live
   replays no longer execute an unconditional, no-op expired-receipt DELETE. This
   removes both a round trip and the DELETE work on the common path. When any
   rotated-key row is expired, delete expired rows and **reread after cleanup**, retaining
   the original visibility ordering and exact deleted-row metrics. The rare expiry
   path trades one extra precheck for eliminating deletes from all ordinary requests.
   Lock acquisition remains a separate SQL statement: reading in its pre-wait snapshot
   could miss a duplicate's commit. Key rotation, quotas, request digests, expiry
   boundaries and rollback remain unchanged.

An earlier CTE variant combined cleanup and lookup to save a round trip, but still
executed the DELETE and produced a synthetic receipt row on every new key. Profiling
showed mixed allocation and high-concurrency results. The final read-first path removes
that unnecessary work rather than just batching it. Rejected-candidate measurements
are retained separately; they are not used to claim final-code performance.

A real PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` at about 2,000 retained audit rows:

| Head lookup | Plan | Buffer hits | Execution time |
|---|---|---:|---:|
| Before | Sequential scan + top-N sort | 138 | 1.764 ms |
| After | `admin_audit_events_chain` index scan | 3 | 0.047 ms |

This is a query-level observation, **not** a claim of an equally faster HTTP service.
`measurements.json` contains all captured HTTP/resource results and profiler summaries.
The unchanged read workload is a control. Shared-host build/test activity makes
short-run p99 and absolute capacity estimates noisy; do not extrapolate them to
production sizing. Cold JWKS fetches, first-ever/legacy audit chains, and configured
rate-limit denial paths are not represented by warmed throughput numbers.

### Final HTTP and resource results

Two alternating before/after repetitions; each case has 128 warm-up operations,
256 measured operations, 2,000 historical audit records, real dependencies, and
identical CPU affinity/configuration. Values below are **means of per-run metrics,
not pooled percentiles**. All 60 cases / 24,576 measured HTTP requests are retained.

| Workload | Workers | Requests/s before → after | p50 ms before → after | p95 ms before → after | p99 ms before → after |
|---|---:|---:|---:|---:|---:|
| read | 1 | 203.3 → 217.9 | 4.6 → 4.3 | 7.5 → 7.4 | 10.8 → 10.5 |
| read | 8 | 470.8 → 462.7 | 15.3 → 15.3 | 28.3 → 28.0 | 32.1 → 32.2 |
| read | 32 | 595.3 → 592.7 | 50.7 → 51.4 | 64.7 → 66.8 | 68.6 → 73.1 |
| replay | 1 | 47.9 → 49.7 | 20.0 → 18.9 | 24.2 → 23.7 | 35.3 → 59.3 |
| replay | 8 | 90.0 → 120.7 | 75.1 → 62.7 | 178.4 → 85.0 | 333.8 → 135.5 |
| replay | 32 | 88.1 → 115.9 | 335.3 → 241.6 | 499.0 → 453.1 | 597.9 → 508.0 |
| session | 1 | 33.8 → 42.9 | 27.1 → 22.6 | 39.2 → 28.4 | 99.0 → 37.8 |
| session | 8 | 76.2 → 80.7 | 100.2 → 90.1 | 140.8 → 128.5 | 193.2 → 452.7 |
| session | 32 | 81.8 → 87.7 | 369.5 → 352.2 | 478.9 → 417.3 | 542.9 → 478.3 |
| invocation | 1 | 40.0 → 46.6 | 22.3 → 20.6 | 35.5 → 28.0 | 78.0 → 38.9 |
| invocation | 8 | 90.8 → 113.7 | 81.4 → 61.6 | 127.8 → 92.5 | 205.8 → 500.1 |
| invocation | 32 | 80.0 → 114.7 | 379.5 → 269.3 | 577.7 → 351.1 | 695.0 → 417.9 |
| delegation | 1 | 25.5 → 37.0 | 34.8 → 26.3 | 58.9 → 31.6 | 139.8 → 41.8 |
| delegation | 8 | 63.9 → 74.7 | 114.9 → 103.8 | 180.4 → 120.2 | 271.1 → 176.8 |
| delegation | 32 | 69.8 → 74.0 | 431.6 → 393.6 | 525.8 → 541.9 | 555.2 → 566.9 |

| Workload | Workers | CPU ms/request before → after | Sampled allocated KiB/request before → after | Peak RSS MiB before → after |
|---|---:|---:|---:|---:|
| read | 1 | 2.71 → 2.61 | 109.8 → 107.2 | 148.4 → 152.5 |
| read | 8 | 1.98 → 2.02 | 98.2 → 94.2 | 150.9 → 154.3 |
| read | 32 | 1.58 → 1.59 | 94.5 → 90.6 | 161.2 → 164.2 |
| replay | 1 | 6.25 → 6.20 | 227.8 → 222.9 | 175.4 → 178.9 |
| replay | 8 | 5.27 → 5.02 | 210.8 → 212.6 | 178.8 → 181.7 |
| replay | 32 | 5.36 → 4.63 | 214.2 → 200.7 | 214.2 → 214.4 |
| session | 1 | 7.89 → 6.55 | 297.3 → 285.4 | 233.0 → 236.2 |
| session | 8 | 5.74 → 5.44 | 276.5 → 271.0 | 236.3 → 239.3 |
| session | 32 | 5.25 → 4.88 | 269.8 → 265.6 | 237.5 → 244.2 |
| invocation | 1 | 5.56 → 5.78 | 240.0 → 236.6 | 242.2 → 245.2 |
| invocation | 8 | 4.97 → 4.51 | 236.7 → 227.8 | 244.3 → 247.0 |
| invocation | 32 | 4.77 → 4.33 | 224.3 → 223.3 | 244.9 → 247.7 |
| delegation | 1 | 8.53 → 7.39 | 353.2 → 337.7 | 246.4 → 249.1 |
| delegation | 8 | 6.47 → 6.23 | 328.4 → 316.2 | 246.3 → 249.4 |
| delegation | 32 | 6.40 → 6.26 | 321.9 → 319.8 | 246.5 → 249.6 |

The unchanged 8/32-worker read controls are approximately flat in throughput.
Mutation throughput improves in this matrix, and the common-path expired DELETE
count falls from one per idempotent operation to **zero**. Allocation and CPU
results are mostly lower; **RSS does not improve**, and no blanket memory claim is made.
p99 does not improve uniformly: replay/1, session/8 and invocation/8 have worse
tails, and delegation/32 p95 is slightly higher. The dependency profiles retain
large commit/lock/scheduling outliers; earlier candidate sensitivity runs without
CPU/heap sampling also showed tail variability. These are not erased or represented
as a universal p99 improvement. Dedicated-host sustained tail-latency validation
remains necessary before capacity/SLO conclusions.

For example, invocation/32 throughput is 80.0 → 114.7 requests/s (+43.4%),
p95 is 577.7 → 351.1 ms (−39.2%), and CPU/request is 9.4% lower.
These are observed measurements under the recorded conditions, not production guarantees.

### Choices deliberately not made

* No JWT/liveness/authority cache: it would weaken immediate revocation checks.
* No narrower graph/start/audit locks: they protect count-then-insert, orphan
  prevention, attenuation and hash-chain consistency.
* No combined lock-and-read SQL snapshot, asynchronous audit gate, dropped events,
  or disabled durable commits. WAL sync and required lock waiting remain costs.
* No Redis client-clock cache, changed bucket keys or changed boundary behavior.
  TIME/INCR round trips are measured but are smaller than the database/lock path.
* No new runtime dependencies, services, workers, schema migrations or production
  configuration changes. Test-only profiling control HTTP runs on loopback and is
  loaded explicitly with `--import`; never preload it into a production service.

## Reproduce

Requirements: repository Node/pnpm/Go toolchains, Docker, `psql`, `redis-cli`,
`openssl`, Linux `taskset`; unused ports 3000, 4000, 8080, 8081, 9090, 14001,
45432 and 46379. Use a quiet host for meaningful capacity comparisons.
All commands below run from the repository root. The fixture uses real PostgreSQL 17,
Redis 7.4, API, STS, Gateway, Audit and Coordinator. It does not use an existing
production stack or touch unrelated containers. Secrets and artifacts stay outside Git.

```bash
pnpm run build:typescript
bash tests/typescript/performance/coordinator/stack.sh init
# Separate terminal, stays in foreground:
bash tests/typescript/performance/coordinator/stack.sh deps
# In the benchmark terminal:
source /tmp/caracal-coordinator-bench/env
node tests/typescript/performance/coordinator/snapshot.mjs /tmp/caracal-coordinator-bench/before \
  --baseline-ref b365fa5d85e43e5eacab1ab0cc42b272b770c9b4
node tests/typescript/performance/coordinator/snapshot.mjs /tmp/caracal-coordinator-bench/after
PERF_OPERATIONS=256 PERF_HISTORY_ROWS=2000 PERF_WARMUP_OPERATIONS=128 PERF_REPEATS=2 \
  node tests/typescript/performance/coordinator/compare.mjs \
  /tmp/caracal-coordinator-bench/before /tmp/caracal-coordinator-bench/after
```

`--baseline-ref` substitutes **only the two optimized modules** from that revision;
all surrounding code and installed dependencies are frozen identically. This isolates
this patch from unrelated workspace changes. For a whole-revision comparison, build
that revision separately and call `snapshot.mjs OUT APP_DIST AUDIT_DIST`; explicitly
set `PERF_ALLOW_DIFFERENT_SURROUNDING_CODE=1` when such differences are intended.
Snapshots include a content-hash/dependency-version manifest. The comparator rejects
any unapproved code/dependency difference before measuring; this caught an unrelated
concurrent database-pool error-listener edit, which was normalized identically in
both artifacts and remeasured rather than attributed to these optimizations. `compare.mjs` alternates
before/after artifacts, pins Coordinator to CPU 14 and client to CPU 15, and waits for
shutdown between versions. Override `PERF_CPU`/`PERF_LOAD_CPU` on smaller machines.

Each workload/concurrency gets a separate governed zone, genuine STS-issued token,
policy activation, real service registration, and 2,000 correctly signed/linked audit
history rows. Historical rows are seeded with the existing audit persistence helper
outside measurement. Each measured variant uses the same input sizes/counts and
128 warm-up operations; default measured count is 512. Concurrent workflows run at
1, 8 and 32 workers. The live outbox must drain before the case is accepted. Fixture
zones are archived and their test audit/outbox history removed; no production data
should be used with this destructive load generator.

`PERF_WORKLOADS=read,replay,session,invocation,delegation`, `PERF_CONCURRENCY=1,8,32`,
`PERF_OPERATIONS`, `PERF_HISTORY_ROWS` and `PERF_WARMUP_OPERATIONS` select the matrix.
Individual live loads can also use `pnpm --dir apps/coordinator perf` with an explicitly
profiled Coordinator running in another terminal.

### Profiling output

Every case produces JSON, `.cpuprofile` and `.heapprofile` files in `PERF_OUTPUT_DIR`:
client p50/p95/p99, mean and throughput; process CPU and CPU/request; peak RSS/heap;
V8 sampled allocated bytes (not exact allocation counts); event-loop p99; per-query
PostgreSQL and per-command Redis count/elapsed/max; pool-acquisition time; and
request-correlated dependency elapsed versus remaining server time. The latter is an
**approximation**: client-observed dependency time includes scheduling/wake-up overhead,
not just dependency CPU, and wall time includes waiting and overlapping work. Process
CPU is a separate measurement. The profiling hooks and sampler themselves add overhead;
both variants use identical hooks. Intentional blocking relay `XREADGROUP` is excluded
from request dependency latency. Background nonblocking dependency calls are retained
in process totals but not charged to request-correlated elapsed time.

Open CPU/heap profiles in a compatible DevTools profiler. Raw profiles from this run
are retained locally under `evidence/coordinator-performance/` (Git-ignored); the checked-in
summary records hashes and hot functions. Recreate it with
`node tests/typescript/performance/coordinator/summarize.mjs "$PERF_OUTPUT_DIR"`. SQL plan evidence is in `audit-head-plans.txt`.

## Correctness and full deployed workflows

```bash
pnpm --dir apps/coordinator build
pnpm --dir packages/adminAudit/ts build
pnpm --dir apps/coordinator test
pnpm exec vitest run tests/typescript/unit/api/admin-audit.test.ts
# Separate terminal. No test profiler; short dependency timeout for deterministic faults:
DB_STATEMENT_TIMEOUT_MS=500 PERF_PROFILE=0 \
  bash tests/typescript/performance/coordinator/stack.sh coordinator
# In another terminal with the fixture environment loaded:
PERF_ALLOW_FAULTS=1 pnpm --dir apps/coordinator test:live
```

Live checks cover concurrent duplicates, digest conflicts, inactive receipts, a commit
made while a rotated-key duplicate waits, expiry/rotation/quota/rollback against real
PostgreSQL, single-writer starts/completions, retries, cancellation/deadlines, service
lease fencing, cross-zone and signature denials, statement timeouts, client disconnect,
partial audit failure/replay, Redis ACL failure/recovery, delegation cascades, and
Coordinator audit-content/hash-chain/HMAC verification. API fixture setup shares the
zone chain; its links/HMACs are checked, but payload-content rehashing is out of scope
because JSONB does not retain the API's original JSON key ordering.

For the full SDK → Coordinator → STS → Gateway → upstream → Audit workflow, run a real
reachable HTTP upstream (not loopback: Gateway's SSRF guard correctly rejects it).
For example, on this isolated test host a small HTTP server in a `node:24-alpine`
container on Docker's private bridge is reachable by the native Gateway. Then:

```bash
printf '%s' "$CARACAL_ADMIN_TOKEN" >/tmp/caracal-coordinator-bench/adminToken
CARACAL_ADMIN_TOKEN_FILE=/tmp/caracal-coordinator-bench/adminToken \
CARACAL_STS_URL="$STS_URL" CARACAL_E2E_UPSTREAM_URL=http://UPSTREAM_PRIVATE_IP:18091 \
  node tests/typescript/e2e/protected-resource.mjs
```

Stop foreground processes with Ctrl-C, then remove only labeled fixture containers:
`bash tests/typescript/performance/coordinator/stack.sh stop`.

## Limitations / review

* No remote/production Caracal endpoint or provider credentials were supplied.
  Validation deploys local source-built services with a real deterministic HTTP upstream,
  not a paid model/third-party provider. The agent-launch E2E requiring external agent
  binaries/provider setup is not claimed. Multi-replica/cloud/TLS/network-partition
  and sustained hours-long soak coverage are not claimed.
* The released baseline grants only SELECT on `applications` to the Coordinator;
  PostgreSQL `FOR SHARE` used by service registration also requires UPDATE privilege.
  Fixture initialization adds **only `UPDATE(id)`** on the disposable DB so that route
  can run. No production grant/migration is changed; a stock deployed schema needs a
  separate least-privilege grant fix before that workflow works.
* Fault checks use a configured 500 ms PostgreSQL statement timeout. An initial run
  under a longer timeout exceeded the client's 30 s deadline on this loaded host;
  default-timeout latency bounds are not established by the successful fault run.
* Implementation-independent live chain and snapshot tests complement existing unit
  tests; they do not replace end-to-end validation. Final diff review specifically checks
  lock lifetime/order, MVCC snapshots, RLS, HMAC compatibility, rollback/pool release,
  legacy rows, unchanged response shapes, quota behavior and partial execution. Existing
  unrelated workspace edits/dependency upgrades are preserved, not attributed to this patch.
