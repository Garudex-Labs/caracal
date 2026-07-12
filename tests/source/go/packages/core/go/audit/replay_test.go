// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for audit Client configuration validation, loss accounting, and replay durability edges.

package audit

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestNewClientValidatesInputs(t *testing.T) {
	dir := t.TempDir()
	if _, err := NewClient(nil, ClientConfig{ReplayDir: dir}); err == nil {
		t.Fatal("nil streamer must be rejected")
	}
	if _, err := NewClient(&fakeStreamer{}, ClientConfig{}); err == nil {
		t.Fatal("empty ReplayDir must be rejected")
	}
	blocked := filepath.Join(dir, "occupied")
	if err := os.WriteFile(blocked, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewClient(&fakeStreamer{}, ClientConfig{ReplayDir: filepath.Join(blocked, "nested")}); err == nil {
		t.Fatal("unusable replay dir must surface the mkdir error")
	}
}

func TestNewClientAppliesDefaults(t *testing.T) {
	c, err := NewClient(&fakeStreamer{}, ClientConfig{ReplayDir: t.TempDir(), Logger: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	if c.cfg.Stream != DefaultStream {
		t.Fatalf("stream default: %q", c.cfg.Stream)
	}
	if c.cfg.BufferCap != defaultBufferCap || c.cfg.FlushBatch != defaultFlushBatch || c.cfg.FlushTTL != defaultFlushTTL {
		t.Fatalf("unexpected defaults: %+v", c.cfg)
	}
	if cap(c.ch) != defaultBufferCap {
		t.Fatalf("channel capacity: %d", cap(c.ch))
	}
}

func TestSnapshotAndStatsHandleNilAndEmptyDir(t *testing.T) {
	var nilClient *Client
	if got := nilClient.Snapshot(); got != (Metrics{}) {
		t.Fatalf("nil snapshot: %+v", got)
	}
	if got := ReplayStatsForDir("", time.Now()); got != (ReplayStats{}) {
		t.Fatalf("empty dir stats: %+v", got)
	}
	if got := ReplayStatsForDir(filepath.Join(t.TempDir(), "missing"), time.Now()); got != (ReplayStats{}) {
		t.Fatalf("missing dir stats: %+v", got)
	}
}

func TestOverflowPersistsWithoutLoss(t *testing.T) {
	c, err := NewClient(&fakeStreamer{}, ClientConfig{
		ReplayDir: t.TempDir(),
		Logger:    zerolog.Nop(),
		BufferCap: 1,
		FlushTTL:  time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	c.Emit(Event{ID: "kept"})
	c.Emit(Event{ID: "persisted"})
	if c.Dropped() != 0 {
		t.Fatalf("dropped: %d", c.Dropped())
	}
	if c.Snapshot().Persisted != 1 {
		t.Fatalf("persisted: %d", c.Snapshot().Persisted)
	}
	if c.Snapshot().QueueDepth != 1 || c.Snapshot().QueueCap != 1 {
		t.Fatalf("queue snapshot: %+v", c.Snapshot())
	}
}

func TestReadyFailsWhenReplayDirVanishes(t *testing.T) {
	c, _, dir := newTestClient(t, nil, false)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := c.Ready(); err == nil {
		t.Fatal("missing replay dir must fail readiness")
	}
}

func TestCloseBeforeStartIsANoop(t *testing.T) {
	c, _, _ := newTestClient(t, nil, false)
	if err := c.Close(context.Background()); err != nil {
		t.Fatalf("close before start: %v", err)
	}
	if err := (*Client)(nil).Close(context.Background()); err != nil {
		t.Fatalf("nil close: %v", err)
	}
}

func TestReplayPendingLogsScanFailure(t *testing.T) {
	c, s, dir := newTestClient(t, nil, false)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	c.ReplayPending(context.Background())
	if len(s.snapshot()) != 0 {
		t.Fatalf("no events should replay from a missing dir: %d", len(s.snapshot()))
	}
}

func TestXAddSurfacesMarshalError(t *testing.T) {
	c, s, _ := newTestClient(t, nil, false)
	err := c.xadd(context.Background(), Event{ID: "bad", DiagnosticsJSON: json.RawMessage("{")})
	if err == nil {
		t.Fatal("invalid raw JSON must fail the marshal")
	}
	if len(s.snapshot()) != 0 {
		t.Fatalf("failed marshal must not reach the stream: %d", len(s.snapshot()))
	}
}

func TestPersistBatchMarshalsAllEventsBeforeCreatingFile(t *testing.T) {
	c, _, dir := newTestClient(t, nil, false)
	if err := c.persistBatch(nil); err != nil {
		t.Fatalf("empty batch: %v", err)
	}
	if stats := ReplayStatsForDir(dir, time.Now()); stats.Files != 0 {
		t.Fatalf("empty batch must write nothing: %+v", stats)
	}
	batch := []Event{{ID: "good"}, {ID: "bad", DiagnosticsJSON: json.RawMessage("{")}}
	if err := c.persistBatch(batch); err == nil {
		t.Fatal("unmarshalable event must fail the whole batch")
	}
	if stats := ReplayStatsForDir(dir, time.Now()); stats.Files != 0 {
		t.Fatalf("marshal failure must happen before file creation: %+v", stats)
	}
}

func TestSuccessfulSpillRemainsReadyAndDefinitiveLossDoesNot(t *testing.T) {
	c, _, dir := newTestClient(t, nil, false)
	if err := c.persistBatch([]Event{{ID: "persisted"}}); err != nil {
		t.Fatal(err)
	}
	if err := c.Ready(); err != nil {
		t.Fatalf("durable spill must remain ready: %v", err)
	}
	c.recordLoss(1, errors.New("disk failed"))
	if err := c.Ready(); !errors.Is(err, ErrEvidenceLost) {
		t.Fatalf("definitive loss readiness error = %v", err)
	}
	if stats := ReplayStatsForDir(dir, time.Now()); stats.Files != 1 {
		t.Fatalf("durable spill must remain available: %+v", stats)
	}
}

func replayFilePath(t *testing.T, dir string) string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == replayFileExt {
			return filepath.Join(dir, entry.Name())
		}
	}
	t.Fatal("no replay file written")
	return ""
}

func TestPersistBatchOpenFailureReturnsError(t *testing.T) {
	c, _, dir := newTestClient(t, nil, false)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := c.persistBatch([]Event{{ID: "ev"}}); err == nil {
		t.Fatal("unwritable replay dir must fail the batch")
	}
	if c.Snapshot().Persisted != 0 {
		t.Fatalf("failed persist must not count: %d", c.Snapshot().Persisted)
	}
}

func TestRunRecordsLossWhenStreamAndDiskBothFail(t *testing.T) {
	c, s, dir := newTestClient(t, nil, false)
	s.failN = 100
	s.failErr = errors.New("redis down")
	var dropped atomic.Uint64
	c.cfg.Metrics.OnDropped = func(n uint64) { dropped.Store(n) }
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.Start(ctx)
	c.Emit(Event{ID: "ev"})
	deadline := time.After(2 * time.Second)
	for dropped.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("definitive loss never recorded")
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if c.Dropped() == 0 {
		t.Fatal("dropped counter must reflect the loss")
	}
}

func TestShutdownDrainLossIsRecordedWithoutMetricsHook(t *testing.T) {
	c, s, dir := newTestClient(t, nil, false)
	s.failN = 100
	s.failErr = errors.New("redis down")
	ctx, cancel := context.WithCancel(context.Background())
	c.Start(ctx)
	c.Emit(Event{ID: "ev"})
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if c.Dropped() == 0 && c.Snapshot().Persisted == 0 {
		t.Fatal("shutdown drain must either persist or record the loss")
	}
}

func TestSyncReplayDirSurfacesOpenError(t *testing.T) {
	if err := syncReplayDir(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing dir must fail the sync")
	}
	if err := syncReplayDir(t.TempDir()); err != nil {
		t.Fatalf("existing dir must sync: %v", err)
	}
}
