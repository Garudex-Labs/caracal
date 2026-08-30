// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package outbox

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenEmptyPathUsesDefaultUnderHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	want := filepath.Join(home, ".caracal", "telemetry_buffer.db")
	if got := DefaultPath(); got != want {
		t.Fatalf("DefaultPath() = %q, want %q", got, want)
	}
	store, err := Open("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if store.Path != want {
		t.Fatalf("store.Path = %q, want %q", store.Path, want)
	}
	if _, err := os.Stat(want); err != nil {
		t.Fatal(err)
	}
}

func TestEnqueueRequiresIdentityFields(t *testing.T) {
	s := testStore(t)
	if _, err := s.Enqueue(batch("s1", 0, "a"), "", "u1", ""); err == nil {
		t.Fatal("missing destination must be rejected")
	}
	if _, err := s.Enqueue(batch("s1", 0, "a"), "http://localhost", "", ""); err == nil {
		t.Fatal("missing user id must be rejected")
	}
	payload := batch("s1", 0, "a")
	payload["harness"] = ""
	if _, err := s.Enqueue(payload, "http://localhost", "u1", ""); err == nil {
		t.Fatal("missing harness must be rejected")
	}
}

func TestEnqueueEndByteOffsetsWinOverTotalOffset(t *testing.T) {
	s := testStore(t)
	payload := batch("s1", 0, "a", "b")
	payload["end_byte_offsets"] = []any{float64(120), float64(987)}
	if _, err := s.Enqueue(payload, "http://localhost", "u1", ""); err != nil {
		t.Fatal(err)
	}
	items, err := s.Pending("http://localhost", "u1", 0)
	if err != nil || len(items) != 1 {
		t.Fatalf("pending: %v err %v", items, err)
	}
	if items[0].EndOffset != 987 {
		t.Fatalf("end offset = %d, want the last byte offset 987", items[0].EndOffset)
	}
}

func TestEnqueueRejectsWhenAtCapacity(t *testing.T) {
	s := testStore(t)
	s.MaxBytes = 1
	if _, err := s.Enqueue(batch("s1", 0, "a"), "http://localhost", "u1", ""); !errors.Is(err, ErrFull) {
		t.Fatalf("want ErrFull, got %v", err)
	}
}

func TestRequeueUpgradesRangeToFinal(t *testing.T) {
	s := testStore(t)
	if _, err := s.Enqueue(batch("s1", 0, "a", "b"), "http://localhost", "u1", ""); err != nil {
		t.Fatal(err)
	}
	// The same records re-queued as final upgrade the row in place.
	payload := batch("s1", 0, "a", "b")
	payload["final"] = true
	if _, err := s.Enqueue(payload, "http://localhost", "u1", ""); err != nil {
		t.Fatal(err)
	}
	items, err := s.Pending("http://localhost", "u1", 0)
	if err != nil || len(items) != 1 {
		t.Fatalf("pending: %v err %v", items, err)
	}
	if !items[0].Final {
		t.Fatalf("row must be final after upgrade: %+v", items[0])
	}
}

func TestPendingHonorsLimit(t *testing.T) {
	s := testStore(t)
	for _, session := range []string{"s1", "s2", "s3"} {
		if _, err := s.Enqueue(batch(session, 0, "a"), "http://localhost", "u1", ""); err != nil {
			t.Fatal(err)
		}
	}
	items, err := s.Pending("http://localhost", "u1", 2)
	if err != nil || len(items) != 2 {
		t.Fatalf("limited pending: %v err %v", items, err)
	}
	// Another user's queue stays invisible.
	items, err = s.Pending("http://localhost", "u2", 0)
	if err != nil || len(items) != 0 {
		t.Fatalf("foreign user pending: %v err %v", items, err)
	}
}

func TestAcknowledgeWithoutMatchesLeavesLastSyncUnset(t *testing.T) {
	s := testStore(t)
	removed, err := s.Acknowledge("http://localhost", "u1", "kiro", "s1", 100, true)
	if err != nil || removed != 0 {
		t.Fatalf("acknowledge removed %d, err %v", removed, err)
	}
	stats, err := s.ReadStats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.LastSync != nil {
		t.Fatalf("last sync must stay unset: %+v", stats)
	}
}

func TestPayloadValueCoercions(t *testing.T) {
	if strOf(nil) != "" || strOf("x") != "x" || strOf(42) != "42" {
		t.Error("strOf coercions wrong")
	}
	if intOf(float64(7)) != 7 || intOf(8) != 8 || intOf(int64(9)) != 9 {
		t.Error("intOf numeric coercions wrong")
	}
	if intOf(json.Number("11")) != 11 {
		t.Error("intOf json.Number wrong")
	}
	if intOf("12") != 0 || intOf(nil) != 0 {
		t.Error("intOf must fall back to zero for unsupported types")
	}
	if boolOf(true) != true || boolOf("true") != false || boolOf(nil) != false {
		t.Error("boolOf coercions wrong")
	}
}
