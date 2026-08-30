// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package logring captures the service's log records in a bounded ring and
// serves them to administrators as JSON and Server-Sent Events, so remote
// operators can tail the server without shell access.
package logring

import (
	"context"
	"log/slog"
	"runtime"
	"sync"
	"time"
)

// Capacity bounds the in-memory record window.
const Capacity = 2000

// Entry is one captured record in the streaming wire shape.
type Entry struct {
	Seq        uint64 `json:"-"`
	Timestamp  string `json:"timestamp"`
	Level      string `json:"level"`
	Event      string `json:"event"`
	LoggerName string `json:"logger_name"`
	Function   string `json:"function"`
	Line       int    `json:"line"`
}

// Ring is the bounded, concurrency-safe record buffer.
type Ring struct {
	mu      sync.Mutex
	entries []Entry
	nextSeq uint64
}

// Append stores one entry, evicting the oldest past capacity.
func (r *Ring) Append(e Entry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextSeq++
	e.Seq = r.nextSeq
	r.entries = append(r.entries, e)
	if len(r.entries) > Capacity {
		r.entries = r.entries[len(r.entries)-Capacity:]
	}
}

// Snapshot returns the buffered entries oldest-first.
func (r *Ring) Snapshot() []Entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Entry, len(r.entries))
	copy(out, r.entries)
	return out
}

// levelRank orders levels for minimum-level filtering.
var levelRank = map[string]int{"TRACE": 0, "DEBUG": 1, "INFO": 2, "WARNING": 3, "ERROR": 4, "CRITICAL": 5}

func rank(level string) int {
	if r, ok := levelRank[upper(level)]; ok {
		return r
	}
	return 0
}

func upper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
	}
	return string(b)
}

func levelName(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return "ERROR"
	case l >= slog.LevelWarn:
		return "WARNING"
	case l >= slog.LevelInfo:
		return "INFO"
	default:
		return "DEBUG"
	}
}

// TeeHandler forwards records to the wrapped handler and captures them in
// the ring.
type TeeHandler struct {
	Next slog.Handler
	Ring *Ring
}

// Enabled defers to the wrapped handler.
func (h *TeeHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.Next.Enabled(ctx, level)
}

// Handle captures the record and forwards it.
func (h *TeeHandler) Handle(ctx context.Context, record slog.Record) error {
	entry := Entry{
		Timestamp:  record.Time.UTC().Format("2006-01-02T15:04:05.000000Z"),
		Level:      levelName(record.Level),
		Event:      record.Message,
		LoggerName: "caracal-server",
	}
	if record.PC != 0 {
		frames := runtime.CallersFrames([]uintptr{record.PC})
		if frame, _ := frames.Next(); frame.Function != "" {
			entry.Function = frame.Function
			entry.Line = frame.Line
		}
	}
	h.Ring.Append(entry)
	return h.Next.Handle(ctx, record)
}

// WithAttrs tees the derived handler onto the same ring.
func (h *TeeHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &TeeHandler{Next: h.Next.WithAttrs(attrs), Ring: h.Ring}
}

// WithGroup tees the derived handler onto the same ring.
func (h *TeeHandler) WithGroup(name string) slog.Handler {
	return &TeeHandler{Next: h.Next.WithGroup(name), Ring: h.Ring}
}

// matches applies the level floor and text filter used by both endpoints.
func matches(e Entry, minRank int, filter string) bool {
	if rank(e.Level) < minRank {
		return false
	}
	if filter == "" {
		return true
	}
	searchable := lower(e.Event + " " + e.LoggerName + " " + e.Function)
	return contains(searchable, lower(filter))
}

func lower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// now is stubbed in tests.
var now = time.Now
