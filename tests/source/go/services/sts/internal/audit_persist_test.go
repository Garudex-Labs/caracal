// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit buffer persistence tests: disk spill, loss accounting, readiness probes, and replay hygiene.

package internal

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func TestPersistBatchMarshalsAllEventsBeforeCreatingFile(t *testing.T) {
	dir := t.TempDir()
	buf := &AuditBuffer{log: zerolog.Nop(), replayDir: dir, metrics: &STSMetrics{}}

	if err := buf.persistBatch(nil); err != nil {
		t.Fatalf("empty batch must be a no-op: %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatal("empty batch must not create replay files")
	}

	batch := []AuditEvent{
		{ID: "ev-good", ZoneID: "zone1", MetadataJSON: json.RawMessage(`{"ok":true}`)},
		{ID: "ev-bad", ZoneID: "zone1", MetadataJSON: json.RawMessage(`{broken`)},
	}
	if err := buf.persistBatch(batch); err == nil {
		t.Fatal("unmarshalable event must fail the whole batch")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("replay files = %v err=%v", entries, err)
	}
	if buf.metrics.AuditReplayPending.Load() != 0 {
		t.Fatalf("pending counter = %d", buf.metrics.AuditReplayPending.Load())
	}
}

func TestSuccessfulSpillRemainsReadyAndDefinitiveLossDoesNot(t *testing.T) {
	buf := &AuditBuffer{log: zerolog.Nop(), replayDir: t.TempDir(), metrics: &STSMetrics{}}
	if err := buf.persistBatch([]AuditEvent{{ID: "persisted"}}); err != nil {
		t.Fatal(err)
	}
	if err := buf.Ready(); err != nil {
		t.Fatalf("durable spill must remain ready: %v", err)
	}
	buf.recordLoss(1, errors.New("disk failed"))
	if err := buf.Ready(); !errors.Is(err, errAuditEvidenceLost) {
		t.Fatalf("definitive loss readiness error = %v", err)
	}
}

func TestPersistBatchFailsWithoutReplayDir(t *testing.T) {
	buf := &AuditBuffer{log: zerolog.Nop(), replayDir: filepath.Join(t.TempDir(), "missing")}
	if err := buf.persistBatch([]AuditEvent{{ID: "ev-1"}}); err == nil {
		t.Fatal("missing replay directory must fail persistence")
	}
}

func TestEmitRecordsLossWhenSpillFails(t *testing.T) {
	metrics := &STSMetrics{}
	buf := &AuditBuffer{
		ch:        make(chan AuditEvent),
		log:       zerolog.Nop(),
		replayDir: filepath.Join(t.TempDir(), "missing"),
		metrics:   metrics,
	}
	buf.Emit(AuditEvent{ID: "ev-lost"})
	if buf.Dropped() != 1 || metrics.AuditDropped.Load() != 1 {
		t.Fatalf("loss accounting: dropped=%d metric=%d", buf.Dropped(), metrics.AuditDropped.Load())
	}
}

func TestReadyChecksReplayDirShape(t *testing.T) {
	if err := (*AuditBuffer)(nil).Ready(); err == nil {
		t.Fatal("nil buffer must not report ready")
	}
	if err := (&AuditBuffer{replayDir: filepath.Join(t.TempDir(), "missing")}).Ready(); err == nil {
		t.Fatal("missing replay dir must not report ready")
	}
	file := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := (&AuditBuffer{replayDir: file}).Ready(); err == nil {
		t.Fatal("file replay path must not report ready")
	}
	if err := (&AuditBuffer{replayDir: t.TempDir()}).Ready(); err != nil {
		t.Fatalf("writable replay dir must report ready: %v", err)
	}
}

func TestCloseHonorsContext(t *testing.T) {
	if err := (*AuditBuffer)(nil).Close(context.Background()); err != nil {
		t.Fatalf("nil buffer close: %v", err)
	}
	if err := (&AuditBuffer{}).Close(context.Background()); err != nil {
		t.Fatalf("unstarted buffer close: %v", err)
	}

	buf := &AuditBuffer{ch: make(chan AuditEvent, 1), redis: &fakeSTSRedis{}, log: zerolog.Nop(), replayDir: t.TempDir()}
	flushCtx, stopFlush := context.WithCancel(context.Background())
	buf.start(flushCtx)

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := buf.Close(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("close with canceled context = %v", err)
	}

	stopFlush()
	if err := buf.Close(context.Background()); err != nil {
		t.Fatalf("close after flusher exit: %v", err)
	}
}

func TestReplayPendingIgnoresNonReplayEntries(t *testing.T) {
	broken := &AuditBuffer{log: zerolog.Nop(), replayDir: filepath.Join(t.TempDir(), "missing")}
	broken.replayPending(context.Background())

	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ev.ndjson"), []byte(`{"id":"ev-1"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	redis := &fakeSTSRedis{}
	buf := &AuditBuffer{redis: redis, log: zerolog.Nop(), replayDir: dir}
	buf.replayPending(context.Background())

	if len(redis.xadds) != 1 {
		t.Fatalf("replayed events = %d", len(redis.xadds))
	}
	if _, err := os.Stat(filepath.Join(dir, "note.txt")); err != nil {
		t.Fatalf("non-replay file must remain: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "nested")); err != nil {
		t.Fatalf("directory entry must remain: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "ev.ndjson")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("drained replay file must be removed, got %v", err)
	}
}

func TestXAddEventRejectsUnmarshalableEvent(t *testing.T) {
	buf := &AuditBuffer{redis: &fakeSTSRedis{}, log: zerolog.Nop()}
	err := buf.xaddEvent(context.Background(), AuditEvent{ID: "ev-1", MetadataJSON: json.RawMessage(`{broken`)})
	if err == nil || !strings.Contains(err.Error(), "marshal") {
		t.Fatalf("unmarshalable event must fail before the stream: %v", err)
	}
}

func TestSyncReplayDirRequiresDirectory(t *testing.T) {
	if err := syncReplayDir(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing directory must fail to sync")
	}
	if err := syncReplayDir(t.TempDir()); err != nil {
		t.Fatalf("existing directory must sync: %v", err)
	}
}
