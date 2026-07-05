// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// PGWriter chain-hash insert and partition/watermark logic tests over faked connections.

package internal

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type scanFuncRow struct {
	fn func(dest ...any) error
}

func (r scanFuncRow) Scan(dest ...any) error {
	if r.fn == nil {
		return nil
	}
	return r.fn(dest...)
}

// insertTx scripts per-call QueryRow and Exec results on top of rehashTx.
type insertTx struct {
	rehashTx
	rows     []pgx.Row
	rowIdx   int
	execTags []pgconn.CommandTag
	execErrs []error
	execIdx  int
}

func (t *insertTx) QueryRow(context.Context, string, ...any) pgx.Row {
	if t.rowIdx < len(t.rows) {
		r := t.rows[t.rowIdx]
		t.rowIdx++
		return r
	}
	return scanFuncRow{}
}

func (t *insertTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	i := t.execIdx
	t.execIdx++
	var tag pgconn.CommandTag
	var err error
	if i < len(t.execTags) {
		tag = t.execTags[i]
	}
	if i < len(t.execErrs) {
		err = t.execErrs[i]
	}
	return tag, err
}

// writerPool scripts pool-level calls for the PGWriter helpers.
type writerPool struct {
	tx       pgx.Tx
	beginErr error
	rows     []pgx.Row
	rowIdx   int
	execSQL  []string
	execErr  error
	query    pgx.Rows
	queryErr error
}

func (p *writerPool) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	return p.tx, p.beginErr
}

func (p *writerPool) QueryRow(context.Context, string, ...any) pgx.Row {
	if p.rowIdx < len(p.rows) {
		r := p.rows[p.rowIdx]
		p.rowIdx++
		return r
	}
	return scanFuncRow{}
}

func (p *writerPool) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return p.query, p.queryErr
}

func (p *writerPool) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	p.execSQL = append(p.execSQL, sql)
	return pgconn.CommandTag{}, p.execErr
}

func (p *writerPool) Acquire(context.Context) (*pgxpool.Conn, error) {
	return nil, errors.New("no live pool")
}

func (p *writerPool) Ping(context.Context) error { return nil }

func chainHeadRow(prevHash string, prevSeq int64, err error) pgx.Row {
	return scanFuncRow{fn: func(dest ...any) error {
		if err != nil {
			return err
		}
		*dest[0].(*string) = prevHash
		*dest[1].(*int64) = prevSeq
		return nil
	}}
}

func insertEvent() AuditEvent {
	return AuditEvent{
		ID:               "event-1",
		ZoneID:           "zone1",
		EventType:        "token_exchange",
		RequestID:        "req-1",
		Decision:         "allow",
		EvaluationStatus: "complete",
		OccurredAt:       time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
}

func insertedTag() pgconn.CommandTag {
	return pgconn.NewCommandTag("INSERT 0 1")
}

func TestInsertAppendsFreshChainHead(t *testing.T) {
	tx := &insertTx{
		rows:     []pgx.Row{scanFuncRow{}, chainHeadRow("", 0, pgx.ErrNoRows)},
		execTags: []pgconn.CommandTag{{}, insertedTag()},
	}
	inserted := 0
	w := &PGWriter{db: &writerPool{tx: tx}, auditHMACKey: []byte("01234567890123456789012345678901"), onInsert: func() { inserted++ }}

	res, err := w.Insert(context.Background(), insertEvent(), "sig")
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if !res.Inserted || res.ChainSeq != 1 || res.ContentSHA256 == "" || res.ChainHMAC == "" {
		t.Fatalf("result = %+v", res)
	}
	if inserted != 1 || !tx.committed {
		t.Fatalf("inserted=%d committed=%v", inserted, tx.committed)
	}
}

func TestInsertContinuesExistingChain(t *testing.T) {
	tx := &insertTx{
		rows:     []pgx.Row{scanFuncRow{}, chainHeadRow("prevhash", 41, nil)},
		execTags: []pgconn.CommandTag{{}, insertedTag()},
	}
	w := &PGWriter{db: &writerPool{tx: tx}}

	res, err := w.Insert(context.Background(), insertEvent(), "")
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if res.ChainSeq != 42 {
		t.Fatalf("chain seq = %d", res.ChainSeq)
	}
	if res.ChainHMAC != "" {
		t.Fatal("hmac must be empty without a key")
	}
}

func TestInsertClassifiesDuplicates(t *testing.T) {
	tx := &insertTx{
		rows: []pgx.Row{scanFuncRow{}, chainHeadRow("", 0, pgx.ErrNoRows), scanFuncRow{fn: func(...any) error { return errors.New("probe failed") }}},
	}
	w := &PGWriter{db: &writerPool{tx: tx}}
	res, err := w.Insert(context.Background(), insertEvent(), "")
	if err != nil || res.Inserted {
		t.Fatalf("benign duplicate = %+v, %v", res, err)
	}
	if !tx.committed {
		t.Fatal("benign duplicate must commit")
	}

	tx = &insertTx{
		rows: []pgx.Row{scanFuncRow{}, chainHeadRow("", 0, pgx.ErrNoRows), scanFuncRow{fn: func(dest ...any) error {
			*dest[0].(*string) = "differenthash"
			return nil
		}}},
	}
	w = &PGWriter{db: &writerPool{tx: tx}}
	if _, err := w.Insert(context.Background(), insertEvent(), ""); !errors.Is(err, ErrConflictMismatch) {
		t.Fatalf("tamper on replay = %v", err)
	}
	if !tx.committed {
		t.Fatal("tamper detection must commit the alert")
	}
}

func TestInsertSurfacesTransactionFailures(t *testing.T) {
	ctx := context.Background()
	ev := insertEvent()

	w := &PGWriter{db: &writerPool{beginErr: errors.New("begin failed")}}
	if _, err := w.Insert(ctx, ev, ""); err == nil {
		t.Fatal("begin error must surface")
	}

	w = &PGWriter{db: &writerPool{tx: &insertTx{execErrs: []error{errors.New("lock failed")}}}}
	if _, err := w.Insert(ctx, ev, ""); err == nil {
		t.Fatal("advisory lock error must surface")
	}

	w = &PGWriter{db: &writerPool{tx: &insertTx{rows: []pgx.Row{scanFuncRow{fn: func(...any) error { return errors.New("canonicalise failed") }}}}}}
	if _, err := w.Insert(ctx, ev, ""); err == nil {
		t.Fatal("canonicalisation error must surface")
	}

	w = &PGWriter{db: &writerPool{tx: &insertTx{rows: []pgx.Row{scanFuncRow{}, chainHeadRow("", 0, errors.New("head failed"))}}}}
	if _, err := w.Insert(ctx, ev, ""); err == nil {
		t.Fatal("chain head error must surface")
	}

	w = &PGWriter{db: &writerPool{tx: &insertTx{
		rows:     []pgx.Row{scanFuncRow{}, chainHeadRow("", 0, pgx.ErrNoRows)},
		execErrs: []error{nil, errors.New("insert failed")},
	}}}
	if _, err := w.Insert(ctx, ev, ""); err == nil {
		t.Fatal("insert error must surface")
	}

	tx := &insertTx{
		rows:     []pgx.Row{scanFuncRow{}, chainHeadRow("", 0, pgx.ErrNoRows)},
		execTags: []pgconn.CommandTag{{}, insertedTag()},
	}
	tx.commitErr = errors.New("commit failed")
	w = &PGWriter{db: &writerPool{tx: tx}}
	if _, err := w.Insert(ctx, ev, ""); err == nil {
		t.Fatal("commit error must surface")
	}
}

func TestLoadWatermarkHandlesMissingRow(t *testing.T) {
	ctx := context.Background()
	hour := time.Date(2026, 2, 1, 5, 0, 0, 0, time.UTC)

	w := &PGWriter{db: &writerPool{rows: []pgx.Row{scanFuncRow{fn: func(...any) error { return pgx.ErrNoRows }}}}}
	got, err := w.LoadWatermark(ctx, "parquet-hourly")
	if err != nil || !got.IsZero() {
		t.Fatalf("missing watermark = %v, %v", got, err)
	}

	w = &PGWriter{db: &writerPool{rows: []pgx.Row{scanFuncRow{fn: func(dest ...any) error {
		*dest[0].(*time.Time) = hour
		return nil
	}}}}}
	got, err = w.LoadWatermark(ctx, "parquet-hourly")
	if err != nil || !got.Equal(hour) {
		t.Fatalf("watermark = %v, %v", got, err)
	}
}

func TestSaveWatermarkAndIngestAlertDelegateToExec(t *testing.T) {
	pool := &writerPool{}
	w := &PGWriter{db: pool}
	if err := w.SaveWatermark(context.Background(), "parquet-hourly", time.Now()); err != nil {
		t.Fatalf("SaveWatermark: %v", err)
	}
	if err := w.RecordIngestAlert(context.Background(), "event-1", "zone1", "content_mismatch_on_replay", "detail"); err != nil {
		t.Fatalf("RecordIngestAlert: %v", err)
	}
	if len(pool.execSQL) != 2 {
		t.Fatalf("exec calls = %d", len(pool.execSQL))
	}

	w = &PGWriter{db: &writerPool{execErr: errors.New("exec failed")}}
	if err := w.SaveWatermark(context.Background(), "parquet-hourly", time.Now()); err == nil {
		t.Fatal("exec error must surface")
	}
}

func TestConfiguredRetentionDaysHandlesOverrides(t *testing.T) {
	ctx := context.Background()

	w := &PGWriter{db: &writerPool{rows: []pgx.Row{scanFuncRow{fn: func(...any) error { return pgx.ErrNoRows }}}}}
	if _, ok, err := w.ConfiguredRetentionDays(ctx); ok || err != nil {
		t.Fatalf("missing override = %v, %v", ok, err)
	}

	w = &PGWriter{db: &writerPool{rows: []pgx.Row{scanFuncRow{fn: func(...any) error { return errors.New("query failed") }}}}}
	if _, _, err := w.ConfiguredRetentionDays(ctx); err == nil {
		t.Fatal("query error must surface")
	}

	w = &PGWriter{db: &writerPool{rows: []pgx.Row{scanFuncRow{fn: func(dest ...any) error {
		*dest[0].(*int) = 42
		return nil
	}}}}}
	days, ok, err := w.ConfiguredRetentionDays(ctx)
	if days != 42 || !ok || err != nil {
		t.Fatalf("override = %d, %v, %v", days, ok, err)
	}
}

func TestEnsurePartitionFormatsMonthlyRange(t *testing.T) {
	pool := &writerPool{}
	w := &PGWriter{db: pool}
	if err := w.EnsurePartition(context.Background(), time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("EnsurePartition: %v", err)
	}
	if len(pool.execSQL) != 1 || !strings.Contains(pool.execSQL[0], "audit_events_y2026m03") {
		t.Fatalf("partition ddl = %v", pool.execSQL)
	}
	if !strings.Contains(pool.execSQL[0], "'2026-03-01'") || !strings.Contains(pool.execSQL[0], "'2026-04-01'") {
		t.Fatalf("partition bounds = %v", pool.execSQL)
	}
}

func TestDropPartitionsBeforeDropsOnlyExpiredMonths(t *testing.T) {
	pool := &writerPool{query: &auditFakeRows{values: [][]any{
		{"audit_events_y2025m01"},
		{"audit_events_y2025m12"},
		{"not_a_partition"},
	}}}
	w := &PGWriter{db: pool}

	dropped, err := w.DropPartitionsBefore(context.Background(), time.Date(2025, 3, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("DropPartitionsBefore: %v", err)
	}
	if len(dropped) != 1 || dropped[0] != "audit_events_y2025m01" {
		t.Fatalf("dropped = %v", dropped)
	}
	if len(pool.execSQL) != 1 || !strings.Contains(pool.execSQL[0], "audit_events_y2025m01") {
		t.Fatalf("drop ddl = %v", pool.execSQL)
	}
}

func TestDropPartitionsBeforeSurfacesFailures(t *testing.T) {
	ctx := context.Background()
	cutoff := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	w := &PGWriter{db: &writerPool{queryErr: errors.New("query failed")}}
	if _, err := w.DropPartitionsBefore(ctx, cutoff); err == nil {
		t.Fatal("query error must surface")
	}

	w = &PGWriter{db: &writerPool{query: &auditFakeRows{values: [][]any{{"audit_events_y2025m01"}}, scanErr: errors.New("scan failed")}}}
	if _, err := w.DropPartitionsBefore(ctx, cutoff); err == nil {
		t.Fatal("scan error must surface")
	}

	w = &PGWriter{db: &writerPool{query: &auditFakeRows{err: errors.New("row stream broken")}}}
	if _, err := w.DropPartitionsBefore(ctx, cutoff); err == nil {
		t.Fatal("rows error must surface")
	}

	w = &PGWriter{db: &writerPool{
		query:   &auditFakeRows{values: [][]any{{"audit_events_y2025m01"}}},
		execErr: errors.New("drop failed"),
	}}
	if _, err := w.DropPartitionsBefore(ctx, cutoff); err == nil {
		t.Fatal("drop error must surface")
	}
}

func TestAcquireAdvisoryLockSurfacesPoolFailure(t *testing.T) {
	w := &PGWriter{db: &writerPool{}}
	if _, _, err := w.AcquireAdvisoryLock(context.Background(), 1); err == nil {
		t.Fatal("acquire error must surface")
	}
}

func TestWriterPingDelegatesToPool(t *testing.T) {
	w := &PGWriter{db: &writerPool{}}
	if err := w.Ping(context.Background()); err != nil {
		t.Fatalf("Ping: %v", err)
	}
}

func TestJSONTextScannerPreservesNullAndValue(t *testing.T) {
	var raw json.RawMessage
	scanner := jsonText(&raw).(*jsonTextScanner)
	if err := scanner.ScanText(pgtype.Text{Valid: false}); err != nil || raw != nil {
		t.Fatalf("null scan = %q, %v", raw, err)
	}
	if err := scanner.ScanText(pgtype.Text{String: `{"a":1}`, Valid: true}); err != nil || string(raw) != `{"a":1}` {
		t.Fatalf("value scan = %q, %v", raw, err)
	}
}
