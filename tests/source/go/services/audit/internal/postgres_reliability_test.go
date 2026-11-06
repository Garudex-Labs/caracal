// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Live ledger tests and benchmarks; CARACAL_TEST_DATABASE_URL must point to a disposable migrated database.

package internal

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type interruptedCommitPool struct {
	auditPool
	controller  *pgxpool.Pool
	afterCommit bool
}

func (p *interruptedCommitPool) BeginTx(ctx context.Context, options pgx.TxOptions) (pgx.Tx, error) {
	tx, err := p.auditPool.BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	return &interruptedCommitTx{Tx: tx, controller: p.controller, afterCommit: p.afterCommit}, nil
}

type interruptedCommitTx struct {
	pgx.Tx
	controller  *pgxpool.Pool
	afterCommit bool
}

func (tx *interruptedCommitTx) Commit(ctx context.Context) error {
	if tx.afterCommit {
		if err := tx.Tx.Commit(ctx); err != nil {
			return err
		}
		// Model a lost commit response after PostgreSQL durably committed the event.
		return errors.New("injected lost commit response")
	}
	// The row has been inserted, but the transaction has not committed. Killing
	// this real backend must roll it back, not leave a partial chain append.
	if _, err := tx.controller.Exec(ctx, `SELECT pg_terminate_backend($1)`, int32(tx.Conn().PgConn().PID())); err != nil {
		return err
	}
	return tx.Tx.Commit(ctx)
}

func TestPostgresAuditCommitFailureRecovery(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(fmt.Sprintf("committed=%v", committed), func(t *testing.T) {
			pool := liveAuditPool(t, 1)
			controller := liveAuditPool(t, 1)
			zone := "reliability-" + uuid.NewString()
			ev := AuditEvent{ID: uuid.NewString(), ZoneID: zone, EventType: "decision", OccurredAt: time.Now()}
			t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM audit_events WHERE zone_id=$1`, zone) })
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			w := &PGWriter{db: &interruptedCommitPool{auditPool: pool, controller: controller, afterCommit: committed}}
			if _, err := w.Insert(ctx, ev, ""); err == nil {
				t.Fatal("commit failure did not surface")
			}
			var count int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE zone_id=$1`, zone).Scan(&count); err != nil {
				t.Fatal(err)
			}
			want := 0
			if committed {
				want = 1
			}
			if count != want {
				t.Fatalf("rows=%d after committed=%v", count, committed)
			}
			w.db = pool
			result, err := w.Insert(ctx, ev, "")
			if err != nil || result.Inserted == committed {
				t.Fatalf("recovery: %+v, %v", result, err)
			}
			var minSeq, maxSeq int64
			if err := pool.QueryRow(ctx, `SELECT count(*),min(chain_seq),max(chain_seq) FROM audit_events WHERE zone_id=$1`, zone).Scan(&count, &minSeq, &maxSeq); err != nil {
				t.Fatal(err)
			}
			if count != 1 || minSeq != 1 || maxSeq != 1 {
				t.Fatalf("recovery forked the chain: rows=%d sequence=%d..%d", count, minSeq, maxSeq)
			}
		})
	}
}

func liveAuditPool(t testing.TB, maxConns int32) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("CARACAL_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("CARACAL_TEST_DATABASE_URL is not set")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns, cfg.MinConns = maxConns, 0
	cfg.ConnConfig.RuntimeParams["caracal.zone_id"] = "*"
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestPostgresCanceledAdvisoryRelease(t *testing.T) {
	pool := liveAuditPool(t, 1)
	other := liveAuditPool(t, 1)
	w := &PGWriter{db: pool}
	key := time.Now().UnixNano()
	lease, ok, err := w.AcquireAdvisoryLock(context.Background(), key)
	if err != nil || !ok {
		t.Fatalf("acquire: %v, %v", ok, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := lease.Release(ctx); err == nil {
		t.Fatal("canceled release should report its error")
	}
	// Acquiring from the same session would hide a leaked lock (advisory locks are reentrant).
	ctx, cancel = context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var acquired bool
	if err := other.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&acquired); err != nil {
		t.Fatal(err)
	}
	if !acquired {
		t.Fatal("canceled release returned a still-locked session to the pool")
	}
	if _, err := other.Exec(ctx, `SELECT pg_advisory_unlock($1)`, key); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresConcurrentAuditReplay(t *testing.T) {
	pool := liveAuditPool(t, 8)
	w := &PGWriter{db: pool, auditHMACKey: []byte("reliability-test-key")}
	zone := "reliability-" + uuid.NewString()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM audit_ingest_alerts WHERE zone_id=$1`, zone)
		_, _ = pool.Exec(context.Background(), `DELETE FROM audit_events WHERE zone_id=$1`, zone)
	})
	const count = 128
	events := make([]AuditEvent, count)
	for i := range events {
		events[i] = AuditEvent{ID: uuid.NewString(), ZoneID: zone, EventType: "decision", OccurredAt: time.Now(), MetadataJSON: []byte(`{"b":2,"a":1}`)}
	}
	errs := make(chan error, 8)
	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, ev := range events {
				if _, err := w.Insert(ctx, ev, ""); err != nil {
					errs <- err
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	rows, err := w.Search(ctx, SearchParams{ZoneID: zone, Since: time.Now().Add(-time.Hour), Until: time.Now().Add(time.Hour), Limit: count + 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != count {
		t.Fatalf("rows=%d, want %d", len(rows), count)
	}
	prev := ""
	for i, row := range rows {
		if row.ChainSeq != int64(i+1) || row.PrevContentSHA256 != prev || row.ContentSHA256 != contentHash(row.Event) || row.ChainHMAC != w.computeHMAC(row.ContentSHA256, prev) {
			t.Fatalf("broken chain at %d: %+v", i, row)
		}
		prev = row.ContentSHA256
	}
	events[0].Decision = "changed"
	if _, err := w.Insert(ctx, events[0], ""); !errors.Is(err, ErrConflictMismatch) {
		t.Fatalf("mismatched replay: %v", err)
	}
	var alerts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_ingest_alerts WHERE zone_id=$1`, zone).Scan(&alerts); err != nil || alerts != 1 {
		t.Fatalf("alerts=%d: %v", alerts, err)
	}
}

func TestPostgresInterruptedAuditInsert(t *testing.T) {
	pool := liveAuditPool(t, 1)
	w := &PGWriter{db: pool}
	zone := "reliability-" + uuid.NewString()
	ev := AuditEvent{ID: uuid.NewString(), ZoneID: zone, EventType: "decision", OccurredAt: time.Now()}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM audit_events WHERE zone_id=$1`, zone) })
	blocker := liveAuditPool(t, 1)
	conn, err := blocker.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(context.Background(), `SELECT pg_advisory_lock(hashtext($1))`, zone); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := w.Insert(ctx, ev, ""); err == nil {
		t.Fatal("blocked insert did not time out")
	}
	if _, err := conn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtext($1))`, zone); err != nil {
		t.Fatal(err)
	}
	ctx, done := context.WithTimeout(context.Background(), 2*time.Second)
	defer done()
	result, err := w.Insert(ctx, ev, "")
	if err != nil || !result.Inserted || result.ChainSeq != 1 {
		t.Fatalf("retry: %+v, %v", result, err)
	}
	result, err = w.Insert(ctx, ev, "")
	if err != nil || result.Inserted {
		t.Fatalf("replay: %+v, %v", result, err)
	}
}

// Seed the benchmark zone with a representative ledger before running this benchmark.
// It intentionally exercises the actual writer, including the lock, commit and JSON normalization.
func BenchmarkPostgresAuditInsert(b *testing.B) {
	pool := liveAuditPool(b, 8)
	w := &PGWriter{db: pool, auditHMACKey: []byte("benchmark-key")}
	zone := os.Getenv("CARACAL_BENCH_ZONE")
	if zone == "" {
		zone = "bench"
	}
	var mu sync.Mutex
	latencies := make([]float64, 0, b.N)
	b.ResetTimer()
	start := time.Now()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			ev := AuditEvent{ID: uuid.NewString(), ZoneID: zone, EventType: "benchmark", OccurredAt: time.Now(), MetadataJSON: []byte(`{"size":128}`)}
			at := time.Now()
			if _, err := w.Insert(context.Background(), ev, ""); err != nil {
				b.Error(err)
				return
			}
			ms := float64(time.Since(at).Nanoseconds()) / 1e6
			mu.Lock()
			latencies = append(latencies, ms)
			mu.Unlock()
		}
	})
	elapsed := time.Since(start)
	b.StopTimer()
	sort.Float64s(latencies)
	if len(latencies) == 0 {
		b.Fatal("no inserts completed")
	}
	for _, p := range []int{50, 95, 99} {
		b.ReportMetric(latencies[(len(latencies)-1)*p/100], fmt.Sprintf("p%d-ms", p))
	}
	b.ReportMetric(float64(len(latencies))/elapsed.Seconds(), "events/s")
}
