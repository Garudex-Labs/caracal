// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the reusable audit Client.

package audit

import (
	"context"
	"errors"
	"os"
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
		HMACKey:    key,
		ReplayDir:  dir,
		Logger:     zerolog.New(os.Stderr).Level(zerolog.Disabled),
		FlushTTL:   5 * time.Millisecond,
		FlushBatch: 4,
		BufferCap:  16,
		Production: prod,
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
		t.Fatal("expected error without HMACKey in production")
	}
}

func TestNewClientRejectsShortHMAC(t *testing.T) {
	dir := t.TempDir()
	_, err := NewClient(&fakeStreamer{}, ClientConfig{
		HMACKey:   []byte("short"),
		ReplayDir: dir,
		Logger:    zerolog.Nop(),
	})
	if err == nil {
		t.Fatal("expected error for short HMACKey")
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

func TestEmitDropsWhenFull(t *testing.T) {
	dir := t.TempDir()
	var dropped atomic.Uint64
	c, err := NewClient(&fakeStreamer{}, ClientConfig{
		HMACKey:    make([]byte, 32),
		ReplayDir:  dir,
		Logger:     zerolog.Nop(),
		FlushTTL:   time.Hour,
		FlushBatch: 1000,
		BufferCap:  2,
		Metrics:    MetricsHook{OnDropped: func(n uint64) { dropped.Store(n) }},
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		c.Emit(Event{ID: "x"})
	}
	if dropped.Load() == 0 {
		t.Fatal("expected drops when buffer is exhausted without consumer")
	}
}

func TestNilClientEmitIsSafe(t *testing.T) {
	var c *Client
	c.Emit(Event{ID: "ev"}) // must not panic
	if c.Dropped() != 0 {
		t.Fatal("nil client should report 0 dropped")
	}
}
