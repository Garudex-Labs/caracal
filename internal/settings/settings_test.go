// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package settings

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// fakeRow answers Scan with a fixed value or pgx.ErrNoRows.
type fakeRow struct {
	value string
	miss  bool
}

func (r fakeRow) Scan(dest ...any) error {
	if r.miss {
		return pgx.ErrNoRows
	}
	*dest[0].(*string) = r.value
	return nil
}

// fakeDB serves settings rows and counts queries.
type fakeDB struct {
	rows    map[string]string
	queries atomic.Int64
}

func (f *fakeDB) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	f.queries.Add(1)
	key := args[0].(string)
	value, ok := f.rows[key]
	return fakeRow{value: value, miss: !ok}
}

func TestStoreReadsAndCaches(t *testing.T) {
	db := &fakeDB{rows: map[string]string{"a.key": "hello"}}
	s := &Store{DB: db}
	ctx := context.Background()

	if got := s.String(ctx, "a.key", "fb"); got != "hello" {
		t.Fatalf("String = %q", got)
	}
	if got := s.String(ctx, "a.key", "fb"); got != "hello" {
		t.Fatalf("cached String = %q", got)
	}
	if n := db.queries.Load(); n != 1 {
		t.Fatalf("queries = %d, want 1 (second read cached)", n)
	}

	// A write followed by Invalidate is visible immediately.
	db.rows["a.key"] = "changed"
	s.Invalidate("a.key")
	if got := s.String(ctx, "a.key", "fb"); got != "changed" {
		t.Fatalf("post-invalidate String = %q", got)
	}
}

func TestStoreExpiry(t *testing.T) {
	db := &fakeDB{rows: map[string]string{"k": "v"}}
	s := &Store{DB: db, maxAge: time.Nanosecond}
	ctx := context.Background()
	_ = s.String(ctx, "k", "")
	time.Sleep(time.Millisecond)
	_ = s.String(ctx, "k", "")
	if n := db.queries.Load(); n != 2 {
		t.Fatalf("queries = %d, want 2 (entry expired)", n)
	}
}

func TestStoreFallbacks(t *testing.T) {
	db := &fakeDB{rows: map[string]string{
		"bool.true":  "TRUE",
		"bool.one":   "1",
		"bool.off":   "off",
		"int.ok":     "42",
		"int.junk":   "4x2",
		"int.neg":    "-3",
		"int.huge":   strings.Repeat("9", 30),
		"str.filled": "value",
	}}
	s := &Store{DB: db}
	ctx := context.Background()

	if !s.Bool(ctx, "bool.true", false) || !s.Bool(ctx, "bool.one", false) {
		t.Error("truthy forms should read true")
	}
	if s.Bool(ctx, "bool.off", true) {
		t.Error("non-truthy value should read false, not fall back")
	}
	if !s.Bool(ctx, "bool.absent", true) {
		t.Error("missing key should fall back")
	}

	if got := s.Int(ctx, "int.ok", 7); got != 42 {
		t.Errorf("Int = %d", got)
	}
	for _, key := range []string{"int.junk", "int.neg", "int.huge", "int.absent"} {
		if got := s.Int(ctx, key, 7); got != 7 {
			t.Errorf("%s: Int = %d, want fallback", key, got)
		}
	}

	if got := s.String(ctx, "str.absent", "fb"); got != "fb" {
		t.Errorf("String fallback = %q", got)
	}
}

func TestStoreConcurrentReads(t *testing.T) {
	db := &fakeDB{rows: map[string]string{"k": "v"}}
	s := &Store{DB: db}
	ctx := context.Background()
	done := make(chan struct{})
	for range 8 {
		go func() {
			defer func() { done <- struct{}{} }()
			for range 100 {
				_ = s.String(ctx, "k", "")
				s.Invalidate("k")
			}
		}()
	}
	for range 8 {
		<-done
	}
}
