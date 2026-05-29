// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for async writer lifecycle, log-level/env resolution, and debug sampling.

package logging

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestEnvResolution(t *testing.T) {
	t.Setenv("CARACAL_ENV", "prod")
	t.Setenv("APP_ENV", "staging")
	if got := env(); got != "prod" {
		t.Fatalf("CARACAL_ENV must win, got %q", got)
	}
	t.Setenv("CARACAL_ENV", "")
	if got := env(); got != "staging" {
		t.Fatalf("APP_ENV must be used when CARACAL_ENV unset, got %q", got)
	}
	t.Setenv("APP_ENV", "")
	if got := env(); got != "development" {
		t.Fatalf("default env must be development, got %q", got)
	}
}

func TestEnvLevel(t *testing.T) {
	cases := map[string]zerolog.Level{
		"debug": zerolog.DebugLevel,
		"warn":  zerolog.WarnLevel,
		"error": zerolog.ErrorLevel,
		"info":  zerolog.InfoLevel,
		"":      zerolog.InfoLevel,
	}
	for raw, want := range cases {
		t.Setenv("LOG_LEVEL", raw)
		if got := envLevel(); got != want {
			t.Fatalf("envLevel(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestAsyncWriterRoundTrip(t *testing.T) {
	sink := &captureWriter{}
	w := &asyncWriter{
		sink:     sink,
		ch:       make(chan []byte, 8),
		queueCap: 8,
		done:     make(chan struct{}),
	}
	go w.run()

	if _, err := w.Write([]byte("line-1\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	w.Flush(time.Second)
	if w.emitted.Load() != 1 {
		t.Fatalf("emitted should be 1, got %d", w.emitted.Load())
	}

	w.Close(time.Second)
	w.Close(time.Second) // idempotent

	if !strings.Contains(sink.String(), "line-1") {
		t.Fatalf("sink missing payload: %q", sink.String())
	}

	// After close, writes fall through synchronously to the sink.
	if _, err := w.Write([]byte("after-close\n")); err != nil {
		t.Fatalf("write after close: %v", err)
	}
	if !strings.Contains(sink.String(), "after-close") {
		t.Fatalf("post-close synchronous write missing: %q", sink.String())
	}
}

func TestAsyncWriterDropsWhenFull(t *testing.T) {
	sink := &captureWriter{}
	w := &asyncWriter{
		sink:     sink,
		ch:       make(chan []byte, 1),
		queueCap: 1,
		done:     make(chan struct{}),
	}
	// No drain goroutine; the queue fills and subsequent writes are dropped.
	w.Write([]byte("a"))
	w.Write([]byte("b"))
	w.Write([]byte("c"))
	if w.dropped.Load() == 0 {
		t.Fatal("expected at least one dropped record when queue is full")
	}
}

func TestSamplingHookDropsByRate(t *testing.T) {
	saved := debugSampleN
	debugSampleN = 3
	debugCounter.Store(0)
	defer func() { debugSampleN = saved }()

	sink := &captureWriter{}
	w := &asyncWriter{
		sink:     sink,
		ch:       make(chan []byte, 16),
		queueCap: 16,
		done:     make(chan struct{}),
	}
	go w.run()
	defer w.Close(time.Second)

	hook := samplingHook{w: w}
	debugLine := []byte(`{"level":"debug","msg":"sampled"}`)
	for i := 0; i < 6; i++ {
		if _, err := hook.Write(debugLine); err != nil {
			t.Fatalf("hook write: %v", err)
		}
	}
	// Non-debug lines are never sampled out.
	if _, err := hook.Write([]byte(`{"level":"info","msg":"keep"}`)); err != nil {
		t.Fatalf("hook write info: %v", err)
	}
	w.Flush(time.Second)
	if got := strings.Count(sink.String(), "sampled"); got != 2 {
		t.Fatalf("1-in-3 sampling of 6 debug lines should emit 2, got %d", got)
	}
	if !strings.Contains(sink.String(), "keep") {
		t.Fatal("info line must always be emitted")
	}
}

func TestIsDebugLineLongPayloadUsesPrefix(t *testing.T) {
	long := []byte(`{"level":"debug","msg":"` + strings.Repeat("x", 200) + `"}`)
	if !isDebugLine(long) {
		t.Fatal("debug marker within first 64 bytes must be detected on long lines")
	}
}

func TestInstallShutdownHandlerStop(t *testing.T) {
	var called bool
	var mu sync.Mutex
	stop := InstallShutdownHandler(func() {
		mu.Lock()
		called = true
		mu.Unlock()
	}, 100*time.Millisecond)
	stop()
	time.Sleep(20 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if called {
		t.Fatal("fn must not run when the handler is stopped without a signal")
	}
}

func TestGlobalWriterLifecycle(t *testing.T) {
	globalWriterMu.Lock()
	saved := globalWriter
	globalWriter = nil
	globalWriterMu.Unlock()
	defer func() {
		globalWriterMu.Lock()
		globalWriter = saved
		globalWriterMu.Unlock()
	}()

	if MetricsSnapshot() != (Metrics{}) {
		t.Fatal("snapshot with no writer must be the zero value")
	}
	FlushDevLogs(time.Millisecond)
	CloseDevLogs(time.Millisecond)

	t.Setenv("CARACAL_LOG_QUEUE_SIZE", "32")
	sink := &captureWriter{}
	w := newAsyncWriter(sink)
	if w.queueCap != 32 {
		t.Fatalf("queue size env must size the writer, got cap %d", w.queueCap)
	}

	w.Write([]byte("metric-line\n"))
	FlushDevLogs(time.Second)
	if MetricsSnapshot().QueueCap != 32 {
		t.Fatalf("snapshot must report the configured queue cap, got %d", MetricsSnapshot().QueueCap)
	}
	CloseDevLogs(time.Second)
}
