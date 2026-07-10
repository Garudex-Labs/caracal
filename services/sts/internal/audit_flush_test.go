// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit buffer configuration validation, signed flush, and replay recovery tests.

package internal

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// captureAuditRedis records audit stream writes and optionally fails them.
type captureAuditRedis struct {
	mu     sync.Mutex
	values []map[string]any
	err    error
}

func (c *captureAuditRedis) XAdd(_ context.Context, _ string, values map[string]any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return c.err
	}
	c.values = append(c.values, values)
	return nil
}

func (c *captureAuditRedis) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.values)
}

func TestNewAuditBufferValidatesConfiguration(t *testing.T) {
	t.Setenv("AUDIT_HMAC_KEY", "")
	if _, err := newAuditBuffer(nil, zerolog.Nop(), true, t.TempDir(), nil); err == nil {
		t.Fatal("production without an HMAC key must fail")
	}
	if _, err := newAuditBuffer(nil, zerolog.Nop(), false, "", nil); err == nil || !strings.Contains(err.Error(), "AUDIT_REPLAY_DIR") {
		t.Fatalf("missing replay dir must fail, got %v", err)
	}

	t.Setenv("AUDIT_HMAC_KEY", "not-hex")
	if _, err := newAuditBuffer(nil, zerolog.Nop(), false, t.TempDir(), nil); err == nil {
		t.Fatal("non-hex HMAC key must fail")
	}

	t.Setenv("AUDIT_HMAC_KEY", "abcd")
	if _, err := newAuditBuffer(nil, zerolog.Nop(), false, t.TempDir(), nil); err == nil {
		t.Fatal("short HMAC key must fail")
	}

	key := strings.Repeat("ab", 32)
	t.Setenv("AUDIT_HMAC_KEY", key)
	buf, err := newAuditBuffer(nil, zerolog.Nop(), true, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(buf.auditHMACKey) != 32 {
		t.Fatalf("decoded key length = %d", len(buf.auditHMACKey))
	}
}

func TestAuditFlushSignsEventsForTheStream(t *testing.T) {
	key := strings.Repeat("ab", 32)
	t.Setenv("AUDIT_HMAC_KEY", key)
	sink := &captureAuditRedis{}
	buf, err := newAuditBuffer(sink, zerolog.Nop(), true, t.TempDir(), &STSMetrics{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	buf.start(ctx)
	buf.Emit(AuditEvent{ID: "ev-1", ZoneID: "zone-1", Decision: "allow"})
	deadline := time.Now().Add(2 * time.Second)
	for sink.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	buf.Close(context.Background())
	if sink.count() != 1 {
		t.Fatalf("flushed events = %d", sink.count())
	}

	values := sink.values[0]
	data, ok := values["data"].(string)
	if !ok || values["id"] != "ev-1" {
		t.Fatalf("stream entry malformed: %#v", values)
	}
	rawKey, _ := hex.DecodeString(key)
	mac := hmac.New(sha256.New, rawKey)
	mac.Write([]byte(data))
	if values["sig"] != hex.EncodeToString(mac.Sum(nil)) {
		t.Fatal("stream entry must carry a valid HMAC signature")
	}
}

func TestAuditFlushFailurePersistsForReplay(t *testing.T) {
	t.Setenv("AUDIT_HMAC_KEY", "")
	dir := t.TempDir()
	sink := &captureAuditRedis{err: errors.New("redis down")}
	metrics := &STSMetrics{}
	buf, err := newAuditBuffer(sink, zerolog.Nop(), false, dir, metrics)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	buf.start(ctx)
	buf.Emit(AuditEvent{ID: "ev-1", ZoneID: "zone-1"})
	deadline := time.Now().Add(2 * time.Second)
	for metrics.AuditSinkErrors.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	buf.Close(context.Background())

	if metrics.AuditSinkErrors.Load() == 0 {
		t.Fatal("sink failure must count as an audit sink error")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) == 0 {
		t.Fatalf("failed flush must persist a replay file: %v err=%v", entries, err)
	}
}

func TestReplayPendingDrainsPersistedEvents(t *testing.T) {
	t.Setenv("AUDIT_HMAC_KEY", "")
	dir := t.TempDir()
	sink := &captureAuditRedis{}
	metrics := &STSMetrics{}
	buf, err := newAuditBuffer(sink, zerolog.Nop(), false, dir, metrics)
	if err != nil {
		t.Fatal(err)
	}

	lines := []string{`{"id":"ev-1","zone_id":"zone-1"}`, "not json", `{"id":"ev-2","zone_id":"zone-1"}`}
	path := filepath.Join(dir, "pending-1-1.ndjson")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	buf.replayPending(context.Background())
	if sink.count() != 2 {
		t.Fatalf("replayed events = %d, want 2 with the malformed line skipped", sink.count())
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("drained replay file must be removed")
	}
	if metrics.AuditReplayReplayed.Load() != 2 {
		t.Fatalf("replay metric = %d", metrics.AuditReplayReplayed.Load())
	}

	failed := &captureAuditRedis{err: errors.New("redis down")}
	buf.redis = failed
	if err := os.WriteFile(path, []byte(`{"id":"ev-3"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	buf.replayPending(context.Background())
	if _, err := os.Stat(path); err != nil {
		t.Fatal("undeliverable replay file must remain for the next start")
	}
}

func TestAuditEventJSONShape(t *testing.T) {
	data, err := json.Marshal(AuditEvent{ID: "ev-1", ZoneID: "zone-1", Decision: "deny"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"zone_id":"zone-1"`) {
		t.Fatalf("audit event JSON shape unexpected: %s", data)
	}
}
