// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit lifecycle helper tests for leader, retention, tamper sweep, and exporter setup.

package internal

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/aws/smithy-go"
	"github.com/rs/zerolog"
)

type fakeLifecycleStore struct {
	ensureErr   error
	dropErr     error
	dropped     []string
	events      []EventRow
	queryErr    error
	watermark   time.Time
	watermarkEr error
	saveErr     error

	ensured int
	saved   []time.Time
}

func (f *fakeLifecycleStore) EnsurePartition(context.Context, time.Time) error {
	f.ensured++
	return f.ensureErr
}

func (f *fakeLifecycleStore) DropPartitionsBefore(context.Context, time.Time) ([]string, error) {
	return f.dropped, f.dropErr
}

func (f *fakeLifecycleStore) QuerySinceFn(_ context.Context, _, _ time.Time, _ bool, fn func(EventRow) error) error {
	if f.queryErr != nil {
		return f.queryErr
	}
	for _, event := range f.events {
		if err := fn(event); err != nil {
			return err
		}
	}
	return nil
}

func (f *fakeLifecycleStore) LoadWatermark(context.Context, string) (time.Time, error) {
	return f.watermark, f.watermarkEr
}

func (f *fakeLifecycleStore) SaveWatermark(_ context.Context, _ string, hour time.Time) error {
	f.saved = append(f.saved, hour)
	return f.saveErr
}

func TestRetentionTickCreatesAndDropsPartitions(t *testing.T) {
	store := &fakeLifecycleStore{dropped: []string{"audit_events_2025_01", "audit_events_2025_02"}}
	retention := newRetention(store, nil, 30, zerolog.Nop())

	retention.tick(context.Background())

	if store.ensured != 4 {
		t.Fatalf("ensured partitions = %d, want 4", store.ensured)
	}
	if retention.createdTotal.Load() != 4 || retention.droppedTotal.Load() != 2 {
		t.Fatalf("created=%d dropped=%d", retention.createdTotal.Load(), retention.droppedTotal.Load())
	}
}

func TestRetentionTickStopsOnStoreErrorsAndRunHonorsCancellation(t *testing.T) {
	store := &fakeLifecycleStore{ensureErr: errors.New("ddl failed")}
	retention := newRetention(store, nil, 30, zerolog.Nop())
	retention.tick(context.Background())
	if retention.createdTotal.Load() != 0 {
		t.Fatalf("created on ensure error = %d", retention.createdTotal.Load())
	}

	store = &fakeLifecycleStore{dropErr: errors.New("drop failed")}
	retention = newRetention(store, nil, 30, zerolog.Nop())
	retention.tick(context.Background())
	if retention.createdTotal.Load() != 4 || retention.droppedTotal.Load() != 0 {
		t.Fatalf("created=%d dropped=%d", retention.createdTotal.Load(), retention.droppedTotal.Load())
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	retention.Run(ctx)
}

func chainHMAC(key []byte, contentSHA, prevSHA string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(contentSHA))
	mac.Write([]byte{'|'})
	mac.Write([]byte(prevSHA))
	return hex.EncodeToString(mac.Sum(nil))
}

func TestTamperSweepCountsMismatchesBreaksAndHMACFailures(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	first := AuditEvent{ID: "event-1", ZoneID: "zone-1", Decision: "allow", OccurredAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	second := AuditEvent{ID: "event-2", ZoneID: "zone-1", Decision: "allow", OccurredAt: time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC)}
	firstHash := contentHash(first)
	events := []EventRow{
		{Event: first, ContentSHA256: firstHash, PrevContentSHA256: "", ChainHMAC: chainHMAC(key, firstHash, ""), ChainSeq: 1},
		{Event: second, ContentSHA256: "wrong", PrevContentSHA256: "broken", ChainHMAC: "wrong", ChainSeq: 2},
	}
	sweeper := newTamperSweeper(&fakeLifecycleStore{events: events}, key, time.Hour, time.Hour, zerolog.Nop())

	sweeper.sweep(context.Background(), time.Hour, true)

	if sweeper.checkedTotal.Load() != 2 || sweeper.mismatchTotal.Load() != 1 || sweeper.chainBreak.Load() != 1 || sweeper.hmacMismatch.Load() != 1 {
		t.Fatalf("checked=%d mismatch=%d breaks=%d hmac=%d", sweeper.checkedTotal.Load(), sweeper.mismatchTotal.Load(), sweeper.chainBreak.Load(), sweeper.hmacMismatch.Load())
	}
	if sweeper.lastSweepUnix.Load() == 0 || sweeper.lastFullUnix.Load() == 0 {
		t.Fatal("expected sweep timestamps")
	}
}

func TestTamperSweepHandlesQueryErrorAndRunCancellation(t *testing.T) {
	sweeper := newTamperSweeper(&fakeLifecycleStore{queryErr: errors.New("query failed")}, nil, time.Hour, time.Hour, zerolog.Nop())
	sweeper.sweep(context.Background(), time.Hour, false)
	if sweeper.checkedTotal.Load() != 0 {
		t.Fatalf("checked after query error = %d", sweeper.checkedTotal.Load())
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	sweeper.Run(ctx)
}

func TestParquetExporterDisabledAndS3PreconditionDetection(t *testing.T) {
	exporter, err := newParquetExporter(&fakeLifecycleStore{}, Config{}, nil, zerolog.Nop())
	if err != nil {
		t.Fatalf("newParquetExporter: %v", err)
	}
	exporter.tick(context.Background())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	exporter.Run(ctx)

	if !isS3PreconditionFailed(&smithy.GenericAPIError{Code: "PreconditionFailed"}) {
		t.Fatal("expected S3 precondition failure detection")
	}
	if isS3PreconditionFailed(errors.New("other")) {
		t.Fatal("ordinary errors must not be treated as S3 precondition failures")
	}
}
