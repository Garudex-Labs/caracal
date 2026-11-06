# PostgreSQL reliability validation — November 6, 2026

Tested on Linux, PostgreSQL 18.6, Node 24.12.0, Go 1.27.2 and an i9-13900H. These are local observations, not production capacity guarantees.

## Actual fixes and regressions

- Failed rollback no longer returns a transaction-local zone or partial writes to another request. Retry backoff releases its checkout first.
- TCP response blackholes are bounded; checked-out connection failures no longer produce uncaught exceptions in API, Coordinator or Auth. Uncertain network commits are **not** automatically replayed.
- Canceled audit lease release closes the still-locked session. Failed replay verification/alert persistence is not acknowledged as a benign duplicate.
- Expired outbox workers cannot overwrite a newer claim, even with the same worker ID. Payloads cannot replace the authoritative outbox ID. Delivery remains at-least-once.
- Twelve simultaneous fresh migrators reproduced catalog races before the bootstrap lock fix. Tests now verify serialization, failed/interrupted DDL rollback, and recovery without duplicate migration effects.
- Audit chain head lookup uses matching null ordering; JSON normalization no longer extends its serialized critical section. The original index remains necessary for ascending searches. Review reproduced a 179.7 ms search regression when it was removed; restoring it reduced the query to 0.301 ms. The shared admin-audit optimization retains legacy ordering and uses its existing index for the global chain.
- Windows quoted PATH entries and URL-encoded checkout paths are covered. Secret bootstrap fails before writing secrets when Windows ACL setup fails.
- Live Go tests disable result caching when `CARACAL_TEST_DATABASE_URL` is set. Independent ESLint configurations have explicit root directories.

## Audit append benchmark

Eight workers, actual `PGWriter.Insert`, small fixed JSON payload. Values below are medians of three runs; p50/p95/p99 are measured request latencies.

| Fixture                                                                      | Events/s | p50 ms | p95 ms | p99 ms |
| ---------------------------------------------------------------------------- | -------: | -----: | -----: | -----: |
| Original, ~100k rows, RAM-backed storage, caracalaudit role, 200 inserts/run |    37.80 |  209.4 |  223.1 |  234.2 |
| Final layout, ~100k rows, same storage/role, 200 inserts/run                 |     1077 |  4.954 |  20.52 |  38.24 |
| Final layout, ~1m rows, NVMe storage, caracalaudit role, 1000 inserts/run    |    178.3 |  41.12 |  68.39 |  83.59 |

The final paired RAM-backed comparison uses the audit role and both required index orderings (~28× throughput); it must not be presented as disk-backed production throughput. Disk tests used `fsync=on`, `synchronous_commit=on` and `full_page_writes=on` and demonstrate the remaining commit-I/O cost.

At ~1m rows, warmed chain-head query execution times were 0.090 ms (audit), 0.026 ms (zone admin audit) and 0.042 ms (global admin audit), using index scans rather than ledger-wide sorts. The transactional upgrade preserved all 1,004,812 audit rows in its before/after counts.

## Stress and failure injection

- 32 callers, eight DB connections: 3,000 logical operations each under opposing row-lock order, TCP reset/reconnect, and immediate PostgreSQL crash/restart; plus 3,000 admin audit appends. Journal counts, both counters, chain links and unique sequences were checked.
- Repeated the four phases on disk-backed PostgreSQL with 16 callers and 1,000 operations/phase. All logical operations completed; reported `failures` in the harness are transient attempts retried using its idempotent journal, not lost operations.
- Exhausted all 80 PostgreSQL connections, observed SQLSTATE 53300, released them, and verified a successful subsequent query and empty acquisition queue.
- Eight concurrent audit writers replay 128 events each. Repeated race-enabled tests verify canonical hashes, HMACs, sequence continuity, mismatch alerts, cancellation, pre-commit backend termination, and simulated loss of a successful commit response.

## Validation and reproduction

Use an **administrative connection to a disposable migrated database**, never production:

```sh
export CARACAL_TEST_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:PORT/caracal'
pnpm run build:typescript
node scripts/runGoTests.mjs
node scripts/runTsTests.mjs
node tests/typescript/performance/postgres/workload.mjs
```

For optional destructive crash injection, set `CARACAL_TEST_PGDATA` to the local tested server's data directory. The harness checks that it matches the connected server. `CARACAL_STRESS_OPERATIONS` and `CARACAL_STRESS_CONCURRENCY` adjust the workload.

The Go benchmark source is staged by the repository's centralized-test convention; benchmark `BenchmarkPostgresAuditInsert` with `-cpu=8` after staging it, without another staging runner active.

Final checks passed: uncached race-enabled Go suite; all 18 TypeScript package suites; workspace lint (existing warnings remain); touched builds/typechecks; fresh-cluster migration, RLS and append-only verification; million-row upgrade; Windows Go service and Bun CLI cross-builds.

**Native Windows installation, NTFS ACL behavior, runtime and shutdown were not executed:** no Windows VM, Wine or PowerShell environment was available. Cross-builds and platform-boundary tests are not native Windows validation. Concurrent unrelated workspace changes were preserved, including the STS index added to the single open migration.
