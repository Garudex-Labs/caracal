// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/outbox"
)

func TestCursorRoundTripAndStickyFinality(t *testing.T) {
	home := t.TempDir()
	if _, _, _, valid := CursorStatus("s1", home); valid {
		t.Fatal("missing state must be invalid")
	}
	if err := WriteCursor("s1", 100, 5, true, home, true); err != nil {
		t.Fatal(err)
	}
	offset, lines, finalized, valid := CursorStatus("s1", home)
	if offset != 100 || lines != 5 || !finalized || !valid {
		t.Fatalf("cursor = %d %d %v %v", offset, lines, finalized, valid)
	}
	// Finality survives ordinary updates but not repairs.
	_ = WriteCursor("s1", 200, 9, false, home, true)
	if _, _, finalized, _ := CursorStatus("s1", home); !finalized {
		t.Fatal("finality must be preserved")
	}
	_ = WriteCursor("s1", 50, 2, false, home, false)
	if _, _, finalized, _ := CursorStatus("s1", home); finalized {
		t.Fatal("repair must clear finality")
	}
}

func TestReadNewRecords(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	// A trailing partial line must not be consumed.
	content := "{\"a\":1}\n\n{\"b\":2}\r\n{\"partial\":"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	lines, offsets, bytesRead, err := ReadNewRecords(path, 0)
	if err != nil || len(lines) != 2 {
		t.Fatalf("lines = %v err %v", lines, err)
	}
	if lines[0] != `{"a":1}` || lines[1] != `{"b":2}` {
		t.Fatalf("lines = %v", lines)
	}
	if offsets[1] != int64(len("{\"a\":1}\n\n{\"b\":2}\r\n")) {
		t.Fatalf("offsets = %v", offsets)
	}
	if bytesRead != offsets[1] {
		t.Fatalf("bytesRead = %d", bytesRead)
	}
	// Resume from the second record's start.
	lines, _, _, _ = ReadNewRecords(path, offsets[0])
	if len(lines) != 1 || lines[0] != `{"b":2}` {
		t.Fatalf("resume lines = %v", lines)
	}
}

func TestLoadConfigPriority(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".caracal")
	_ = os.MkdirAll(dir, 0o755)
	write := func(body string) {
		if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"server_url":"http://x","access_token":"jwt","api_key":"legacy","user_id":"u1","default_org":"acme","default_project":"platform"}`)
	cfg := LoadConfig(home)
	if cfg == nil || cfg.AccessToken != "jwt" || cfg.UserID != "u1" || cfg.OrgSlug != "acme" || cfg.ProjectSlug != "platform" {
		t.Fatalf("cfg = %+v", cfg)
	}
	write(`{"server_url":"http://x"}`)
	if LoadConfig(home) != nil {
		t.Fatal("missing token must yield nil")
	}
}

func TestPostToServerAckMintsTenantTokenFromSession(t *testing.T) {
	var tokenRequests, ingestRequests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/tenant-token":
			tokenRequests++
			if got := r.Header.Get("Authorization"); got != "Bearer cli-session" {
				t.Errorf("tenant-token auth = %q", got)
			}
			_, _ = w.Write([]byte(`{"token":"fresh-jwt"}`))
		case "/api/v1/ingest/session":
			ingestRequests++
			if got := r.Header.Get("Authorization"); got != "Bearer fresh-jwt" {
				t.Errorf("ingest auth = %q", got)
			}
			if r.Header.Get("X-Caracal-Org") != "acme" || r.Header.Get("X-Caracal-Project") != "platform" {
				t.Errorf("ingest scope = %q/%q", r.Header.Get("X-Caracal-Org"), r.Header.Get("X-Caracal-Project"))
			}
			_, _ = w.Write([]byte(`{"acknowledged_line":0,"acknowledged_offset":10}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	cfg := &Config{ServerURL: srv.URL, AccessToken: "stale-jwt", SessionToken: "cli-session", OrgSlug: "acme", ProjectSlug: "platform", ConfigPath: filepath.Join(t.TempDir(), "config.json")}
	ack, err := PostToServerAck(cfg, map[string]any{"session_id": "s1", "lines": []any{"{}"}})
	if err != nil || ack == nil || ack.AcknowledgedLine != 0 || ack.AcknowledgedOffset != 10 {
		t.Fatalf("ack=%+v err=%v", ack, err)
	}
	if tokenRequests != 1 || ingestRequests != 1 {
		t.Fatalf("tokenRequests=%d ingestRequests=%d", tokenRequests, ingestRequests)
	}
}

func TestPostToServerAckStopsWhenSessionRevoked(t *testing.T) {
	var ingestRequests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/tenant-token" {
			http.Error(w, `{"detail":"revoked"}`, http.StatusUnauthorized)
			return
		}
		ingestRequests++
	}))
	defer srv.Close()
	cfg := &Config{ServerURL: srv.URL, AccessToken: "stale-jwt", SessionToken: "revoked", OrgSlug: "acme", ProjectSlug: "platform", ConfigPath: filepath.Join(t.TempDir(), "config.json")}
	ack, err := PostToServerAck(cfg, map[string]any{"session_id": "s1", "lines": []any{"{}"}})
	if err != nil || ack != nil {
		t.Fatalf("ack=%+v err=%v", ack, err)
	}
	if ingestRequests != 0 {
		t.Fatalf("ingest reached after revoked session: %d", ingestRequests)
	}
}

func TestServerCheckpointMintsTenantTokenFromSession(t *testing.T) {
	var tokenRequests, checkpointRequests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/tenant-token":
			tokenRequests++
			_, _ = w.Write([]byte(`{"token":"fresh-jwt"}`))
		case "/api/v1/ingest/session/checkpoint":
			checkpointRequests++
			if got := r.Header.Get("Authorization"); got != "Bearer fresh-jwt" {
				t.Errorf("checkpoint auth = %q", got)
			}
			if r.Header.Get("X-Caracal-Org") != "acme" || r.Header.Get("X-Caracal-Project") != "platform" {
				t.Errorf("checkpoint scope = %q/%q", r.Header.Get("X-Caracal-Org"), r.Header.Get("X-Caracal-Project"))
			}
			_, _ = w.Write([]byte(`{"acknowledged_line":2,"acknowledged_offset":30}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	cfg := &Config{ServerURL: srv.URL, AccessToken: "stale-jwt", SessionToken: "cli-session", OrgSlug: "acme", ProjectSlug: "platform", ConfigPath: filepath.Join(t.TempDir(), "config.json")}
	ack := ServerCheckpoint(cfg, "kiro", "s1")
	if ack == nil || ack.AcknowledgedLine != 2 || ack.AcknowledgedOffset != 30 {
		t.Fatalf("ack=%+v", ack)
	}
	if tokenRequests != 1 || checkpointRequests != 1 {
		t.Fatalf("tokenRequests=%d checkpointRequests=%d", tokenRequests, checkpointRequests)
	}
}

func drainFixture(t *testing.T) (*Config, DrainOptions, *outbox.Store) {
	t.Helper()
	home := t.TempDir()
	dbPath := filepath.Join(home, ".caracal", "telemetry_buffer.db")
	store, err := outbox.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	cfg := &Config{ServerURL: "http://server", AccessToken: "tok", UserID: "u1", OrgSlug: "acme", ProjectSlug: "platform"}
	return cfg, DrainOptions{Home: home, DBPath: dbPath}, store
}

func enqueue(t *testing.T, store *outbox.Store, session string, start int, final bool, lines ...string) {
	t.Helper()
	items := make([]any, len(lines))
	for i, l := range lines {
		items[i] = l
	}
	payload := map[string]any{
		"harness": "kiro", "session_id": session,
		"start_offset": float64(start), "lines": items,
		"total_offset": float64((start + len(lines)) * 10),
	}
	if final {
		payload["final"] = true
	}
	if _, err := store.Enqueue(payload, "http://server#scope=acme/platform", "u1", ""); err != nil {
		t.Fatal(err)
	}
}

func TestDrainHappyPath(t *testing.T) {
	cfg, opts, store := drainFixture(t)
	enqueue(t, store, "s1", 0, false, "a", "b")
	enqueue(t, store, "s1", 2, true, "c")
	posted := 0
	opts.Post = func(_ *Config, payload map[string]any) (*Acknowledgement, error) {
		posted++
		lines := payload["lines"].([]any)
		end := int64(payload["start_offset"].(float64)) + int64(len(lines)) - 1
		return &Acknowledgement{AcknowledgedLine: end, AcknowledgedOffset: (end + 1) * 10}, nil
	}
	drained, err := DrainOutbox(cfg, opts, nil, nil)
	if err != nil || !drained || posted != 2 {
		t.Fatalf("drained=%v posted=%d err=%v", drained, posted, err)
	}
	offset, lineCount, finalized, _ := CursorStatus("s1", opts.Home)
	if offset != 30 || lineCount != 3 || !finalized {
		t.Fatalf("cursor = %d %d %v", offset, lineCount, finalized)
	}
	stats, _ := store.ReadStats()
	if stats.Pending != 0 {
		t.Fatalf("pending = %d", stats.Pending)
	}
}

func TestDrainTransientFailureStops(t *testing.T) {
	cfg, opts, store := drainFixture(t)
	enqueue(t, store, "s1", 0, false, "a")
	opts.Post = func(*Config, map[string]any) (*Acknowledgement, error) { return nil, nil }
	drained, err := DrainOutbox(cfg, opts, nil, nil)
	if err != nil || drained {
		t.Fatalf("drained=%v err=%v", drained, err)
	}
	items, _ := store.Pending("http://server#scope=acme/platform", "u1", 0)
	if len(items) != 1 || items[0].Attempts != 1 {
		t.Fatalf("items = %+v", items)
	}
}

func TestDrainPermanentRejectionQuarantines(t *testing.T) {
	cfg, opts, store := drainFixture(t)
	enqueue(t, store, "bad", 0, false, "x")
	enqueue(t, store, "good", 0, false, "y")
	opts.Post = func(_ *Config, payload map[string]any) (*Acknowledgement, error) {
		if payload["session_id"] == "bad" {
			return nil, fmt.Errorf("%w with status 422", ErrPermanentRejection)
		}
		return &Acknowledgement{AcknowledgedLine: 0, AcknowledgedOffset: 10}, nil
	}
	rejections := []Rejection{}
	drained, err := DrainOutbox(cfg, opts, &rejections, nil)
	if err != nil || !drained {
		t.Fatalf("drained=%v err=%v", drained, err)
	}
	if len(rejections) != 1 || rejections[0].SessionID != "bad" || rejections[0].StatusCode != 422 {
		t.Fatalf("rejections = %+v", rejections)
	}
	stats, _ := store.ReadStats()
	if stats.Failed != 1 || stats.Pending != 0 {
		t.Fatalf("stats = %+v", stats)
	}
	if _, err := os.Stat(filepath.Join(opts.Home, ".caracal", "sync.log")); err != nil {
		t.Fatal("sync.log must record the quarantine")
	}
}

func TestDrainRepairRewindsCursor(t *testing.T) {
	cfg, opts, store := drainFixture(t)
	_ = WriteCursor("s1", 500, 50, true, opts.Home, true)
	enqueue(t, store, "s1", 50, false, "z")
	rewind := int64(10)
	opts.Post = func(*Config, map[string]any) (*Acknowledgement, error) {
		return &Acknowledgement{AcknowledgedLine: 9, AcknowledgedOffset: 100, RepairFromLine: &rewind}, nil
	}
	repairs := []Repair{}
	drained, err := DrainOutbox(cfg, opts, nil, &repairs)
	if err != nil || drained || len(repairs) != 1 {
		t.Fatalf("drained=%v repairs=%v err=%v", drained, repairs, err)
	}
	offset, lineCount, finalized, _ := CursorStatus("s1", opts.Home)
	if offset != 100 || lineCount != 10 || finalized {
		t.Fatalf("cursor after repair = %d %d %v", offset, lineCount, finalized)
	}
	stats, _ := store.ReadStats()
	if stats.Pending != 0 {
		t.Fatalf("repair must accept the item: %+v", stats)
	}
}

func TestDrainPartialAckStops(t *testing.T) {
	cfg, opts, store := drainFixture(t)
	enqueue(t, store, "s1", 0, false, "a", "b", "c")
	opts.Post = func(*Config, map[string]any) (*Acknowledgement, error) {
		return &Acknowledgement{AcknowledgedLine: 1, AcknowledgedOffset: 20}, nil
	}
	drained, err := DrainOutbox(cfg, opts, nil, nil)
	if err != nil || drained {
		t.Fatalf("drained=%v err=%v", drained, err)
	}
	items, _ := store.Pending("http://server#scope=acme/platform", "u1", 0)
	if len(items) != 1 {
		t.Fatalf("batch must remain queued: %+v", items)
	}
}

func TestPermanentRejectionSentinel(t *testing.T) {
	err := fmt.Errorf("%w with status 413", ErrPermanentRejection)
	if !errors.Is(err, ErrPermanentRejection) {
		t.Fatal("sentinel must survive wrapping")
	}
}
