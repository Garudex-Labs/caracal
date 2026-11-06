// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit chain rehash tests over a faked Postgres pool and transaction.

package internal

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
)

// auditFakeRows is a scripted pgx.Rows for the rehash queries.
type auditFakeRows struct {
	values  [][]any
	index   int
	err     error
	scanErr error
}

func (r *auditFakeRows) Close()                                       {}
func (r *auditFakeRows) Err() error                                   { return r.err }
func (r *auditFakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *auditFakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *auditFakeRows) Values() ([]any, error)                       { return nil, nil }
func (r *auditFakeRows) RawValues() [][]byte                          { return nil }
func (r *auditFakeRows) Conn() *pgx.Conn                              { return nil }

func (r *auditFakeRows) Next() bool {
	if r.index >= len(r.values) {
		return false
	}
	r.index++
	return true
}

func (r *auditFakeRows) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	row := r.values[r.index-1]
	if len(dest) != len(row) {
		return errors.New("scan destination count mismatch")
	}
	for i, value := range row {
		switch d := dest[i].(type) {
		case *string:
			s, ok := value.(string)
			if !ok {
				return errors.New("expected string column")
			}
			*d = s
		case *time.Time:
			ts, ok := value.(time.Time)
			if !ok {
				return errors.New("expected timestamp column")
			}
			*d = ts
		default:
			return errors.New("unsupported scan destination")
		}
	}
	return nil
}

// markerRow answers the rehash marker EXISTS probe.
type markerRow struct {
	done bool
	err  error
}

func (r markerRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if b, ok := dest[0].(*bool); ok {
		*b = r.done
	}
	return nil
}

type rehashBatchResults struct {
	err error
}

func (b rehashBatchResults) Exec() (pgconn.CommandTag, error) { return pgconn.CommandTag{}, b.err }
func (b rehashBatchResults) Query() (pgx.Rows, error)         { return nil, b.err }
func (b rehashBatchResults) QueryRow() pgx.Row                { return markerRow{err: b.err} }
func (b rehashBatchResults) Close() error                     { return b.err }

// rehashTx is a scripted pgx.Tx capturing batches and commit state.
type rehashTx struct {
	execErr    error
	rows       pgx.Rows
	queryErr   error
	batchErr   error
	commitErr  error
	batches    []*pgx.Batch
	committed  bool
	rolledBack bool
}

func (t *rehashTx) Begin(context.Context) (pgx.Tx, error) { return t, nil }
func (t *rehashTx) Commit(context.Context) error {
	t.committed = true
	return t.commitErr
}
func (t *rehashTx) Rollback(context.Context) error {
	t.rolledBack = true
	return nil
}
func (t *rehashTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}
func (t *rehashTx) SendBatch(_ context.Context, b *pgx.Batch) pgx.BatchResults {
	t.batches = append(t.batches, b)
	return rehashBatchResults{err: t.batchErr}
}
func (t *rehashTx) LargeObjects() pgx.LargeObjects { return pgx.LargeObjects{} }
func (t *rehashTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}
func (t *rehashTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, t.execErr
}
func (t *rehashTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return t.rows, t.queryErr
}
func (t *rehashTx) QueryRow(context.Context, string, ...any) pgx.Row { return markerRow{} }
func (t *rehashTx) Conn() *pgx.Conn                                  { return nil }

// rehashPool is a scripted auditPool for RehashChains.
type rehashPool struct {
	markerDone bool
	markerErr  error
	zones      pgx.Rows
	zonesErr   error
	tx         pgx.Tx
	beginErr   error
	execErr    error
	execCount  int
}

func (p *rehashPool) QueryRow(context.Context, string, ...any) pgx.Row {
	return markerRow{done: p.markerDone, err: p.markerErr}
}
func (p *rehashPool) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return p.zones, p.zonesErr
}
func (p *rehashPool) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	return p.tx, p.beginErr
}
func (p *rehashPool) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	p.execCount++
	return pgconn.CommandTag{}, p.execErr
}
func (p *rehashPool) Acquire(context.Context) (*pgxpool.Conn, error) {
	return nil, errors.New("no live pool")
}
func (p *rehashPool) Ping(context.Context) error { return nil }

func rehashEventRow(id string) []any {
	return []any{
		id, "zone1", "token_exchange", "req-1", "allow",
		"", "", "", "complete",
		"null", "null", "null",
		time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
}

func rehashWriter(pool *rehashPool) *PGWriter {
	return &PGWriter{db: pool, auditHMACKey: []byte("01234567890123456789012345678901")}
}

func TestRehashChainsSkipsWhenAlreadyDone(t *testing.T) {
	pool := &rehashPool{markerDone: true}
	if err := rehashWriter(pool).RehashChains(context.Background(), zerolog.Nop()); err != nil {
		t.Fatalf("RehashChains: %v", err)
	}
	if pool.execCount != 0 {
		t.Fatal("completed rehash must not write a marker")
	}
}

func TestRehashChainsToleratesMissingMarkerTable(t *testing.T) {
	pool := &rehashPool{markerErr: &pgconn.PgError{Code: "42P01"}}
	if err := rehashWriter(pool).RehashChains(context.Background(), zerolog.Nop()); err != nil {
		t.Fatalf("RehashChains: %v", err)
	}
}

func TestRehashChainsSurfacesProbeAndZoneErrors(t *testing.T) {
	ctx := context.Background()

	pool := &rehashPool{markerErr: errors.New("probe failed")}
	if err := rehashWriter(pool).RehashChains(ctx, zerolog.Nop()); err == nil {
		t.Fatal("marker probe error must surface")
	}

	pool = &rehashPool{zonesErr: errors.New("zones failed")}
	if err := rehashWriter(pool).RehashChains(ctx, zerolog.Nop()); err == nil {
		t.Fatal("zone query error must surface")
	}

	pool = &rehashPool{zones: &auditFakeRows{values: [][]any{{"zone1"}}, scanErr: errors.New("scan failed")}}
	if err := rehashWriter(pool).RehashChains(ctx, zerolog.Nop()); err == nil {
		t.Fatal("zone scan error must surface")
	}

	pool = &rehashPool{zones: &auditFakeRows{err: errors.New("row stream broken")}}
	if err := rehashWriter(pool).RehashChains(ctx, zerolog.Nop()); err == nil {
		t.Fatal("zone rows error must surface")
	}
}

func TestRehashChainsRewritesEveryZoneAndRecordsMarker(t *testing.T) {
	tx := &rehashTx{rows: &auditFakeRows{values: [][]any{rehashEventRow("event-1"), rehashEventRow("event-2")}}}
	pool := &rehashPool{zones: &auditFakeRows{values: [][]any{{"zone1"}}}, tx: tx}

	if err := rehashWriter(pool).RehashChains(context.Background(), zerolog.Nop()); err != nil {
		t.Fatalf("RehashChains: %v", err)
	}
	if len(tx.batches) != 1 || tx.batches[0].Len() != 2 {
		t.Fatalf("batches = %d", len(tx.batches))
	}
	if !tx.committed {
		t.Fatal("zone rewrite must commit")
	}
	if pool.execCount != 1 {
		t.Fatalf("marker inserts = %d", pool.execCount)
	}
}

func TestRehashChainsSurfacesMarkerInsertFailure(t *testing.T) {
	tx := &rehashTx{rows: &auditFakeRows{}}
	pool := &rehashPool{zones: &auditFakeRows{values: [][]any{{"zone1"}}}, tx: tx, execErr: errors.New("insert failed")}
	if err := rehashWriter(pool).RehashChains(context.Background(), zerolog.Nop()); err == nil {
		t.Fatal("marker insert error must surface")
	}
}

func TestRehashZoneSurfacesTransactionFailures(t *testing.T) {
	ctx := context.Background()

	pool := &rehashPool{beginErr: errors.New("begin failed")}
	if _, err := rehashWriter(pool).rehashZone(ctx, "zone1"); err == nil {
		t.Fatal("begin error must surface")
	}

	pool = &rehashPool{tx: &rehashTx{execErr: errors.New("lock failed")}}
	if _, err := rehashWriter(pool).rehashZone(ctx, "zone1"); err == nil {
		t.Fatal("advisory lock error must surface")
	}

	pool = &rehashPool{tx: &rehashTx{queryErr: errors.New("select failed")}}
	if _, err := rehashWriter(pool).rehashZone(ctx, "zone1"); err == nil {
		t.Fatal("select error must surface")
	}

	pool = &rehashPool{tx: &rehashTx{rows: &auditFakeRows{values: [][]any{rehashEventRow("event-1")}, scanErr: errors.New("scan failed")}}}
	if _, err := rehashWriter(pool).rehashZone(ctx, "zone1"); err == nil {
		t.Fatal("scan error must surface")
	}

	pool = &rehashPool{tx: &rehashTx{rows: &auditFakeRows{err: errors.New("row stream broken")}}}
	if _, err := rehashWriter(pool).rehashZone(ctx, "zone1"); err == nil {
		t.Fatal("rows error must surface")
	}

	pool = &rehashPool{tx: &rehashTx{rows: &auditFakeRows{values: [][]any{rehashEventRow("event-1")}}, batchErr: errors.New("batch failed")}}
	if _, err := rehashWriter(pool).rehashZone(ctx, "zone1"); err == nil {
		t.Fatal("batch error must surface")
	}

	pool = &rehashPool{tx: &rehashTx{rows: &auditFakeRows{values: [][]any{rehashEventRow("event-1")}}, commitErr: errors.New("commit failed")}}
	if _, err := rehashWriter(pool).rehashZone(ctx, "zone1"); err == nil {
		t.Fatal("commit error must surface")
	}
}

func TestRehashZoneChainsPreviousContentHash(t *testing.T) {
	tx := &rehashTx{rows: &auditFakeRows{values: [][]any{rehashEventRow("event-1"), rehashEventRow("event-2")}}}
	pool := &rehashPool{tx: tx}
	n, err := rehashWriter(pool).rehashZone(context.Background(), "zone1")
	if err != nil || n != 2 {
		t.Fatalf("rehashZone = %d, %v", n, err)
	}
	queued := tx.batches[0].QueuedQueries
	first := queued[0].Arguments
	second := queued[1].Arguments
	if prev, ok := first[1].(*string); !ok || prev != nil {
		t.Fatalf("first prev hash = %v, want nil", first[1])
	}
	if prev, ok := second[1].(*string); !ok || prev == nil || *prev != first[0].(string) {
		t.Fatalf("second prev hash = %v, want %v", second[1], first[0])
	}
}
