// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package audit records request-level audit events into the tamper-evident
// audit_log table. Records are hash-chained per process and batch-inserted;
// auditing must never block or fail a request, so writes are buffered and
// flush failures only log a gap warning.
package audit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

const (
	flushInterval  = 2 * time.Second
	flushThreshold = 500
	insertSQL      = "INSERT INTO audit_log SETTINGS async_insert=0 FORMAT JSONEachRow"
)

// Record is one audit event, matching the audit_log columns.
type Record struct {
	EventID      string  `json:"event_id"`
	Timestamp    string  `json:"timestamp"`
	ActorID      string  `json:"actor_id"`
	ActorEmail   string  `json:"actor_email"`
	ActorRole    string  `json:"actor_role"`
	Action       string  `json:"action"`
	ResourceType string  `json:"resource_type"`
	ResourceID   string  `json:"resource_id"`
	ResourceName string  `json:"resource_name"`
	HTTPMethod   string  `json:"http_method"`
	HTTPPath     string  `json:"http_path"`
	StatusCode   int     `json:"status_code"`
	IPAddress    string  `json:"ip_address"`
	UserAgent    string  `json:"user_agent"`
	Detail       string  `json:"detail"`
	Sensitivity  string  `json:"sensitivity"`
	RequestID    string  `json:"request_id"`
	Outcome      string  `json:"outcome"`
	DurationMS   float64 `json:"duration_ms"`
	ChainHash    string  `json:"chain_hash"`
	Source       string  `json:"source"`
}

// Logger buffers audit records and batch-inserts them.
type Logger struct {
	client *clickhouse.Client

	mu       sync.Mutex
	buffer   []Record
	prevHash string

	stop chan struct{}
	done chan struct{}
}

// NewLogger starts the background flusher. Call Close on shutdown to drain.
func NewLogger(client *clickhouse.Client) *Logger {
	l := &Logger{
		client:   client,
		prevHash: strings.Repeat("0", 64),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
	go l.run()
	return l
}

// Log chains and buffers one record. Non-blocking beyond a mutex.
func (l *Logger) Log(record Record) {
	if record.Timestamp == "" {
		record.Timestamp = time.Now().UTC().Format("2006-01-02 15:04:05.000")
	}
	if record.Source == "" {
		record.Source = "server"
	}
	record.UserAgent = truncate(record.UserAgent, 256)

	l.mu.Lock()
	record.ChainHash = l.chainLocked(record)
	l.buffer = append(l.buffer, record)
	shouldFlush := len(l.buffer) >= flushThreshold
	l.mu.Unlock()

	if shouldFlush {
		l.flush()
	}
}

// chainLocked links the record into the per-process hash chain.
func (l *Logger) chainLocked(record Record) string {
	payload, err := json.Marshal(record)
	if err != nil {
		payload = []byte(record.EventID)
	}
	sum := sha256.Sum256(append([]byte(l.prevHash), payload...))
	l.prevHash = hex.EncodeToString(sum[:])
	return l.prevHash
}

func (l *Logger) run() {
	defer close(l.done)
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			l.flush()
		case <-l.stop:
			l.flush()
			return
		}
	}
}

func (l *Logger) flush() {
	l.mu.Lock()
	batch := l.buffer
	l.buffer = nil
	l.mu.Unlock()
	if len(batch) == 0 {
		return
	}

	rows := make([]any, len(batch))
	for i := range batch {
		rows[i] = &batch[i]
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := l.client.InsertJSONEachRow(ctx, insertSQL, rows); err != nil {
		slog.Error("audit flush failed - audit trail has a gap", "rows", len(batch), "error", err)
	}
}

// Close drains the buffer and stops the flusher.
func (l *Logger) Close() {
	close(l.stop)
	<-l.done
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
