// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package outbox

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "telemetry_buffer.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func batch(session string, start int, lines ...string) map[string]any {
	items := make([]any, len(lines))
	for i, line := range lines {
		items[i] = line
	}
	return map[string]any{
		"harness": "kiro", "session_id": session,
		"start_offset": float64(start), "lines": items,
		"total_offset": float64(start*100 + len(lines)*100),
	}
}

func TestEnqueueIdempotentAndConflict(t *testing.T) {
	s := testStore(t)
	first, err := s.Enqueue(batch("s1", 0, "a", "b"), "http://localhost", "u1", "")
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Enqueue(batch("s1", 0, "a", "b"), "http://localhost/", "u1", "")
	if err != nil || again != first {
		t.Fatalf("idempotent requeue: id %d vs %d, err %v", again, first, err)
	}
	if _, err := s.Enqueue(batch("s1", 0, "a", "DIFFERENT"), "http://localhost", "u1", ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("want conflict, got %v", err)
	}
}

func TestEnqueueValidation(t *testing.T) {
	s := testStore(t)
	if _, err := s.Enqueue(map[string]any{"harness": "kiro", "session_id": "x"}, "d", "u", ""); err == nil {
		t.Fatal("empty payload without metadata must be rejected")
	}
	if _, err := s.Enqueue(batch("", 0, "a"), "d", "u", ""); err == nil {
		t.Fatal("missing session id must be rejected")
	}
}

func TestPendingOrderAndAcknowledge(t *testing.T) {
	s := testStore(t)
	// A metadata-only final row sorts after record batches.
	meta := map[string]any{
		"harness": "kiro", "session_id": "s1", "start_offset": float64(5),
		"lines": []any{}, "final": true, "total_offset": float64(500),
	}
	if _, err := s.Enqueue(meta, "http://localhost", "u1", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Enqueue(batch("s1", 0, "a", "b", "c"), "http://localhost", "u1", ""); err != nil {
		t.Fatal(err)
	}
	items, err := s.Pending("http://localhost", "u1", 0)
	if err != nil || len(items) != 2 {
		t.Fatalf("pending: %v err %v", items, err)
	}
	if items[0].StartLine != 0 || items[0].EndLine != 2 || !items[1].Final {
		t.Fatalf("order wrong: %+v", items)
	}

	removed, err := s.Acknowledge("http://localhost", "u1", "kiro", "s1", 2, false)
	if err != nil || removed != 1 {
		t.Fatalf("acknowledge removed %d, err %v", removed, err)
	}
	// Metadata row survives until include_metadata acknowledges it.
	items, _ = s.Pending("http://localhost", "u1", 0)
	if len(items) != 1 || !items[0].Final {
		t.Fatalf("metadata row should remain: %+v", items)
	}
	removed, err = s.Acknowledge("http://localhost", "u1", "kiro", "s1", 10, true)
	if err != nil || removed != 1 {
		t.Fatalf("metadata acknowledge removed %d, err %v", removed, err)
	}
	stats, err := s.ReadStats()
	if err != nil || stats.Pending != 0 || stats.LastSync == nil {
		t.Fatalf("stats after ack: %+v err %v", stats, err)
	}
}

func TestSpooledCheckpoint(t *testing.T) {
	s := testStore(t)
	if _, err := s.Enqueue(batch("s1", 3, "d", "e"), "http://localhost", "u1", "ck"); err != nil {
		t.Fatal(err)
	}
	// Contiguity: server checkpoint at line 3 extends through the queued 3-4.
	offset, expected, err := s.SpooledCheckpoint("http://localhost", "u1", "kiro", "s1", "ck", 3, 250)
	if err != nil || expected != 5 || offset != 500 {
		t.Fatalf("checkpoint = (%d, %d), err %v", offset, expected, err)
	}
	// A gap stops extension.
	offset, expected, err = s.SpooledCheckpoint("http://localhost", "u1", "kiro", "s1", "ck", 1, 90)
	if err != nil || expected != 1 || offset != 90 {
		t.Fatalf("gapped checkpoint = (%d, %d), err %v", offset, expected, err)
	}
}

func TestAttemptsAndQuarantine(t *testing.T) {
	s := testStore(t)
	if _, err := s.Enqueue(batch("s1", 0, "a"), "http://localhost", "u1", ""); err != nil {
		t.Fatal(err)
	}
	items, _ := s.Pending("http://localhost", "u1", 0)
	if err := s.RecordAttempt(items[0].ID); err != nil {
		t.Fatal(err)
	}
	items, _ = s.Pending("http://localhost", "u1", 0)
	if items[0].Attempts != 1 {
		t.Fatalf("attempts = %d", items[0].Attempts)
	}
	path, err := s.Quarantine(items[0], "schema rejected")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	stats, _ := s.ReadStats()
	if stats.Pending != 0 || stats.Failed != 1 || stats.Total != 1 {
		t.Fatalf("stats after quarantine: %+v", stats)
	}
}

func TestStatsFreshStore(t *testing.T) {
	s := testStore(t)
	stats, err := s.ReadStats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Pending != 0 || stats.Failed != 0 || stats.Sent != 0 || stats.Total != 0 {
		t.Fatalf("fresh stats: %+v", stats)
	}
	if stats.OldestPending != nil || stats.LastSync != nil {
		t.Fatalf("fresh nullables: %+v", stats)
	}
	if stats.Bytes <= 0 {
		t.Fatalf("bytes = %d", stats.Bytes)
	}
	info, err := os.Stat(s.Path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("db perms: %v err %v", info.Mode(), err)
	}
}
