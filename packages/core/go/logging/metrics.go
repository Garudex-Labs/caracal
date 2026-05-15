// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Non-blocking async writer and process-level dev-log metrics snapshot.

package logging

import (
	"io"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Metrics captures counters for dev-log throughput, useful for /metrics exposure.
type Metrics struct {
	Emitted    uint64 `json:"emitted"`
	Dropped    uint64 `json:"dropped"`
	QueueDepth uint64 `json:"queue_depth"`
	QueueCap   uint64 `json:"queue_cap"`
	Sampled    uint64 `json:"sampled"`
}

var (
	globalWriter   *asyncWriter
	globalWriterMu sync.Mutex
)

func newAsyncWriter(sink io.Writer) *asyncWriter {
	globalWriterMu.Lock()
	defer globalWriterMu.Unlock()
	if globalWriter != nil {
		return globalWriter
	}
	cap := uint64(16384)
	if v := os.Getenv("CARACAL_LOG_QUEUE_SIZE"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil && n > 0 {
			cap = n
		}
	}
	w := &asyncWriter{
		sink:    sink,
		ch:      make(chan []byte, cap),
		queueCap: cap,
		done:    make(chan struct{}),
	}
	go w.run()
	globalWriter = w
	return w
}

type asyncWriter struct {
	sink     io.Writer
	ch       chan []byte
	queueCap uint64
	emitted  atomic.Uint64
	dropped  atomic.Uint64
	closed   atomic.Bool
	done     chan struct{}
}

func (w *asyncWriter) Write(p []byte) (int, error) {
	if w.closed.Load() {
		return w.sink.Write(p)
	}
	buf := make([]byte, len(p))
	copy(buf, p)
	select {
	case w.ch <- buf:
		w.emitted.Add(1)
	default:
		w.dropped.Add(1)
	}
	return len(p), nil
}

func (w *asyncWriter) run() {
	defer close(w.done)
	for buf := range w.ch {
		_, _ = w.sink.Write(buf)
	}
}

// Flush drains pending records, blocking until the writer queue is empty or
// timeout elapses.
func (w *asyncWriter) Flush(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if len(w.ch) == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Close stops the background drain after flushing. Idempotent.
func (w *asyncWriter) Close(timeout time.Duration) {
	if !w.closed.CompareAndSwap(false, true) {
		return
	}
	w.Flush(timeout)
	close(w.ch)
	select {
	case <-w.done:
	case <-time.After(timeout):
	}
}

// MetricsSnapshot returns a stable snapshot of the current dev-log counters.
func MetricsSnapshot() Metrics {
	if globalWriter == nil {
		return Metrics{}
	}
	return Metrics{
		Emitted:    globalWriter.emitted.Load(),
		Dropped:    globalWriter.dropped.Load(),
		QueueDepth: uint64(len(globalWriter.ch)),
		QueueCap:   globalWriter.queueCap,
		Sampled:    debugCounter.Load(),
	}
}

// FlushDevLogs blocks until the background queue is drained or timeout elapses.
func FlushDevLogs(timeout time.Duration) {
	if globalWriter == nil {
		return
	}
	globalWriter.Flush(timeout)
}

// CloseDevLogs flushes and stops the dev-log writer. Idempotent.
func CloseDevLogs(timeout time.Duration) {
	if globalWriter == nil {
		return
	}
	globalWriter.Close(timeout)
}

// InstallShutdownHandler wires SIGTERM/SIGINT to flush the dev-log writer and
// invoke fn (typically AuditClient.Close) before exit. Returns a stop function
// that callers can invoke to remove the handler in tests.
func InstallShutdownHandler(fn func(), timeout time.Duration) func() {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	stopCh := make(chan struct{})
	go func() {
		select {
		case <-sigCh:
			if fn != nil {
				fn()
			}
			CloseDevLogs(timeout)
		case <-stopCh:
		}
		signal.Stop(sigCh)
	}()
	return func() { close(stopCh) }
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
