// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the reusable audit Client.

package audit

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

type fakeStreamer struct {
	mu      sync.Mutex
	calls   []map[string]any
	failN   int
	failErr error
}

func (f *fakeStreamer) XAdd(_ context.Context, _ string, values map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failN > 0 {
		f.failN--
		return f.failErr
	}
	cp := make(map[string]any, len(values))
	for k, v := range values {
		cp[k] = v
	}
	f.calls = append(f.calls, cp)
	return nil
}

func (f *fakeStreamer) snapshot() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]map[string]any, len(f.calls))
	copy(out, f.calls)
	return out
}

func newTestClient(t *testing.T, key []byte, prod bool) (*Client, *fakeStreamer, string) {
	t.Helper()
	dir := t.TempDir()
	s := &fakeStreamer{}
	c, err := NewClient(s, ClientConfig{
		AuditHMACKey: key,
		ReplayDir:    dir,
		Logger:       zerolog.New(os.Stderr).Level(zerolog.Disabled),
		FlushTTL:     5 * time.Millisecond,
		FlushBatch:   4,
		BufferCap:    16,
		Production:   prod,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c, s, dir
}

func TestNewClientRequiresHMACInProduction(t *testing.T) {
	dir := t.TempDir()
	_, err := NewClient(&fakeStreamer{}, ClientConfig{
		ReplayDir:  dir,
		Logger:     zerolog.Nop(),
		Production: true,
	})
	if err == nil {
		t.Fatal("expected error without AuditHMACKey in production")
	}
}

func TestNewClientRejectsShortHMAC(t *testing.T) {
	dir := t.TempDir()
	_, err := NewClient(&fakeStreamer{}, ClientConfig{
		AuditHMACKey: []byte("short"),
		ReplayDir:    dir,
		Logger:       zerolog.Nop(),
	})
	if err == nil {
		t.Fatal("expected error for short AuditHMACKey")
	}
}

func TestEmitFlushesBatchAndSigns(t *testing.T) {
	key := make([]byte, 32)
	c, s, _ := newTestClient(t, key, true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.Start(ctx)
	for i := 0; i < 3; i++ {
		c.Emit(Event{ID: "ev", ZoneID: "z"})
	}
	deadline := time.After(500 * time.Millisecond)
	for {
		if len(s.snapshot()) == 3 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("expected 3 flushed events, got %d", len(s.snapshot()))
		case <-time.After(5 * time.Millisecond):
		}
	}
	for _, call := range s.snapshot() {
		if call["sig"] == nil || call["sig"] == "" {
			t.Fatalf("expected sig field, got %v", call)
		}
	}
}

func TestSinkFailurePersistsToDisk(t *testing.T) {
	c, s, dir := newTestClient(t, nil, false)
	s.failN = 100
	s.failErr = errors.New("redis down")
	ctx, cancel := context.WithCancel(context.Background())
	c.Start(ctx)
	for i := 0; i < 5; i++ {
		c.Emit(Event{ID: "ev"})
	}
	time.Sleep(80 * time.Millisecond)
	cancel()
	time.Sleep(20 * time.Millisecond)
	files, _ := os.ReadDir(dir)
	if len(files) == 0 {
		t.Fatal("expected at least one persisted batch")
	}
}

func TestCloseWaitsForReplayPersistence(t *testing.T) {
	c, s, dir := newTestClient(t, nil, false)
	s.failN = 100
	s.failErr = errors.New("redis down")
	ctx, cancel := context.WithCancel(context.Background())
	c.Start(ctx)
	c.Emit(Event{ID: "ev"})
	cancel()
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("expected persisted batch")
	}
}

func TestEmitPersistsWhenFull(t *testing.T) {
	dir := t.TempDir()
	var dropped atomic.Uint64
	c, err := NewClient(&fakeStreamer{}, ClientConfig{
		AuditHMACKey: make([]byte, 32),
		ReplayDir:    dir,
		Logger:       zerolog.Nop(),
		FlushTTL:     time.Hour,
		FlushBatch:   1000,
		BufferCap:    2,
		Metrics:      MetricsHook{OnDropped: func(n uint64) { dropped.Store(n) }},
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		c.Emit(Event{ID: "x"})
	}
	if dropped.Load() != 0 {
		t.Fatalf("overflow must not drop durable events: %d", dropped.Load())
	}
	if c.Snapshot().Persisted != 8 {
		t.Fatalf("overflow persisted = %d", c.Snapshot().Persisted)
	}
}

func TestNilClientEmitIsSafe(t *testing.T) {
	var c *Client
	c.Emit(Event{ID: "ev"}) // must not panic
	if c.Dropped() != 0 {
		t.Fatal("nil client should report 0 dropped")
	}
}

func TestReplayStatsForDirReportsFilesBytesAndOldestAge(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pending-1.ndjson"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ignore.txt"), []byte("not replay"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(filepath.Join(dir, "pending-1.ndjson"), old, old); err != nil {
		t.Fatal(err)
	}

	stats := ReplayStatsForDir(dir, time.Now())
	if stats.Files != 1 {
		t.Fatalf("expected one replay file, got %d", stats.Files)
	}
	if stats.Bytes == 0 {
		t.Fatal("expected replay bytes")
	}
	if stats.OldestAgeSeconds < 7_000 {
		t.Fatalf("expected oldest replay age near two hours, got %d", stats.OldestAgeSeconds)
	}
}

func TestClientReadyChecksReplayDirectory(t *testing.T) {
	if err := (*Client)(nil).Ready(); err == nil {
		t.Fatal("nil client must fail readiness")
	}

	c, _, dir := newTestClient(t, nil, false)
	if err := c.Ready(); err != nil {
		t.Fatalf("ready directory should pass: %v", err)
	}

	filePath := filepath.Join(dir, "not-a-dir")
	if err := os.WriteFile(filePath, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	c.cfg.ReplayDir = filePath
	if err := c.Ready(); err == nil {
		t.Fatal("file replay path must fail readiness")
	}
}

func TestReplayPendingDrainsSignedFilesAndIgnoresInvalidLines(t *testing.T) {
	key := []byte("12345678901234567890123456789012")
	c, s, dir := newTestClient(t, key, true)
	var drained atomic.Uint64
	c.cfg.Metrics.OnReplayDrained = func(n uint64) { drained.Add(n) }
	path := filepath.Join(dir, "pending-1.ndjson")
	if err := os.WriteFile(path, []byte("{bad json}\n{\"id\":\"ev-1\",\"zone_id\":\"z1\",\"event_type\":\"token_exchange\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ignore.txt"), []byte("{\"id\":\"ignored\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	c.ReplayPending(context.Background())

	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("drained replay file should be removed, got %v", err)
	}
	calls := s.snapshot()
	if len(calls) != 1 {
		t.Fatalf("want one replayed event, got %d", len(calls))
	}
	if calls[0]["sig"] == "" {
		t.Fatalf("replayed event should be signed: %#v", calls[0])
	}
	if drained.Load() != 1 || c.Snapshot().Drained != 1 {
		t.Fatalf("unexpected drained metrics hook=%d snapshot=%d", drained.Load(), c.Snapshot().Drained)
	}
}

func TestReplayPendingKeepsFileOnSinkFailure(t *testing.T) {
	c, s, dir := newTestClient(t, nil, false)
	s.failN = 1
	s.failErr = errors.New("sink down")
	path := filepath.Join(dir, "pending-1.ndjson")
	if err := os.WriteFile(path, []byte("{\"id\":\"ev-1\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	c.ReplayPending(context.Background())

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("failed replay file should remain, got %v", err)
	}
	if c.Snapshot().Drained != 0 {
		t.Fatalf("failed replay should not count as drained: %d", c.Snapshot().Drained)
	}
}

func TestReplayFileSurfacesScannerErrors(t *testing.T) {
	c, _, dir := newTestClient(t, nil, false)
	path := filepath.Join(dir, "oversized.ndjson")
	if err := os.WriteFile(path, append(make([]byte, 1024*1024+1), '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := c.replayFile(context.Background(), path); err == nil {
		t.Fatal("oversized replay line should surface scanner error")
	}
}

func TestPersistBatchInvokesMetricHookAndSnapshot(t *testing.T) {
	c, _, dir := newTestClient(t, nil, false)
	var persisted atomic.Uint64
	c.cfg.Metrics.OnReplayPersisted = func(n uint64) { persisted.Add(n) }

	c.persistBatch([]Event{{ID: "ev-1"}, {ID: "ev-2"}})

	if persisted.Load() != 2 || c.Snapshot().Persisted != 2 {
		t.Fatalf("unexpected persisted metrics hook=%d snapshot=%d", persisted.Load(), c.Snapshot().Persisted)
	}
	stats := ReplayStatsForDir(dir, time.Now())
	if stats.Files != 1 {
		t.Fatalf("want one replay file, got %d", stats.Files)
	}
}

func TestPersistBatchDoesNotRecordSuccessWhenReplayDirSyncFails(t *testing.T) {
	c, _, dir := newTestClient(t, nil, false)
	var persisted atomic.Uint64
	c.cfg.Metrics.OnReplayPersisted = func(n uint64) { persisted.Add(n) }

	var syncCalled bool
	c.syncReplayDir = func(got string) error {
		syncCalled = true
		if got != dir {
			t.Fatalf("syncReplayDir got %q, want %q", got, dir)
		}
		return errors.New("dir sync unsupported")
	}

	if err := c.persistBatch([]Event{{ID: "ev-1"}, {ID: "ev-2"}}); err == nil {
		t.Fatal("directory sync failure must fail persistence")
	}
	if !syncCalled {
		t.Fatal("expected replay directory sync attempt")
	}
	if persisted.Load() != 0 || c.Snapshot().Persisted != 0 {
		t.Fatalf("unexpected persisted metrics hook=%d snapshot=%d", persisted.Load(), c.Snapshot().Persisted)
	}
	stats := ReplayStatsForDir(dir, time.Now())
	if stats.Files != 1 {
		t.Fatalf("want one replay file, got %d", stats.Files)
	}
}

func TestCloseReturnsContextErrorWhenFlushDoesNotFinish(t *testing.T) {
	c, _, _ := newTestClient(t, nil, false)
	c.done = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.Close(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("want context canceled, got %v", err)
	}
}
