// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway JTI replay tracker unit tests.

package internal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/audit"
	"github.com/rs/zerolog"
)

type fakeJTIRedis struct {
	created  bool
	setErr   error
	setNXKey string
	setNXTTL time.Duration
}

func (f *fakeJTIRedis) SetNXTTL(_ context.Context, key, _ string, ttl time.Duration) (bool, error) {
	f.setNXKey = key
	f.setNXTTL = ttl
	return f.created, f.setErr
}

type fakeReplayEmitter struct {
	events []audit.Event
}

func (f *fakeReplayEmitter) Emit(ev audit.Event) {
	f.events = append(f.events, ev)
}

func TestNewJTITrackerRequiresRedis(t *testing.T) {
	if _, err := newJTITracker(nil, zerolog.Nop(), false, nil); err == nil {
		t.Fatal("nil redis must fail tracker construction")
	}
	tracker, err := newJTITracker(&fakeJTIRedis{}, zerolog.Nop(), false, nil)
	if err != nil || tracker == nil {
		t.Fatalf("valid redis must construct tracker, got %v", err)
	}
}

func TestJTICheckSkipsUntrackableTokens(t *testing.T) {
	redis := &fakeJTIRedis{}
	tracker := &jtiTracker{redis: redis, log: zerolog.Nop()}
	future := time.Now().Add(time.Minute)

	if !tracker.Check(context.Background(), "", future, "resource", "req-1", "resource://nucleus", "zone-1", "app-1", "fp-1") {
		t.Fatal("empty jti must pass without tracking")
	}
	if !tracker.Check(context.Background(), "jti-1", future, "session", "req-1", "resource://nucleus", "zone-1", "app-1", "fp-1") {
		t.Fatal("session mandates must pass without tracking")
	}
	if !tracker.Check(context.Background(), "jti-1", time.Now().Add(-time.Second), "resource", "req-1", "resource://nucleus", "zone-1", "app-1", "fp-1") {
		t.Fatal("expired tokens must pass without tracking")
	}
	if redis.setNXKey != "" {
		t.Fatalf("untrackable tokens must never touch redis, got key %q", redis.setNXKey)
	}
}

func TestJTICheckAllowsFirstUse(t *testing.T) {
	redis := &fakeJTIRedis{created: true}
	tracker := &jtiTracker{redis: redis, log: zerolog.Nop()}
	if !tracker.Check(context.Background(), "jti-1", time.Now().Add(time.Minute), "resource", "req-1", "resource://nucleus", "zone-1", "app-1", "fp-1") {
		t.Fatal("first use must pass")
	}
	if redis.setNXKey != seenJTIPrefix+"jti-1" {
		t.Fatalf("unexpected marker key %q", redis.setNXKey)
	}
	if redis.setNXTTL <= 0 || redis.setNXTTL > time.Minute {
		t.Fatalf("marker ttl must match remaining token life, got %v", redis.setNXTTL)
	}
}

func TestJTICheckRejectsReplayAndEmitsAudit(t *testing.T) {
	redis := &fakeJTIRedis{created: false}
	emitter := &fakeReplayEmitter{}
	tracker := &jtiTracker{redis: redis, log: zerolog.Nop(), audit: emitter}

	if tracker.Check(context.Background(), "jti-1", time.Now().Add(time.Minute), "resource", "req-1", "resource://nucleus", "zone-1", "app-1", "fp-1") {
		t.Fatal("replayed resource mandate must be rejected")
	}
	if len(emitter.events) != 1 {
		t.Fatalf("replay must emit exactly one audit event, got %d", len(emitter.events))
	}
	event := emitter.events[0]
	if event.EventType != "replay_detected" {
		t.Fatalf("unexpected event type %q", event.EventType)
	}
	if event.ZoneID != "zone-1" || event.RequestID != "req-1" || event.Decision != "deny" || event.EvaluationStatus != "anomaly" {
		t.Fatalf("audit event must carry deny anomaly attribution, got %#v", event)
	}
	var meta map[string]any
	if err := json.Unmarshal(event.MetadataJSON, &meta); err != nil {
		t.Fatalf("decode audit metadata: %v", err)
	}
	if meta["jti"] != "jti-1" || meta["resource"] != "resource://nucleus" || meta["client_id"] != "app-1" || meta["subject_fp"] != "fp-1" {
		t.Fatalf("audit metadata must carry forensic fields, got %#v", meta)
	}
}

func TestJTICheckRejectsReplayWithoutEmitter(t *testing.T) {
	redis := &fakeJTIRedis{created: false}
	tracker := &jtiTracker{redis: redis, log: zerolog.Nop()}
	if tracker.Check(context.Background(), "jti-1", time.Now().Add(time.Minute), "resource", "req-1", "resource://nucleus", "zone-1", "app-1", "fp-1") {
		t.Fatal("replay must be rejected even without a wired audit emitter")
	}
}

func TestJTICheckRedisErrorHonorsFailOpenSetting(t *testing.T) {
	redis := &fakeJTIRedis{setErr: errors.New("redis down")}
	closed := &jtiTracker{redis: redis, log: zerolog.Nop(), failOpen: false}
	if closed.Check(context.Background(), "jti-1", time.Now().Add(time.Minute), "resource", "req-1", "resource://nucleus", "zone-1", "app-1", "fp-1") {
		t.Fatal("fail-closed tracker must reject when redis is unreachable")
	}
	open := &jtiTracker{redis: redis, log: zerolog.Nop(), failOpen: true}
	if !open.Check(context.Background(), "jti-1", time.Now().Add(time.Minute), "resource", "req-1", "resource://nucleus", "zone-1", "app-1", "fp-1") {
		t.Fatal("fail-open tracker must allow when redis is unreachable")
	}
}

func TestJWTJTIAndUseExtraction(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"jti":"token-1","use":"resource"}`))
	token := "header." + payload + ".sig"
	if jwtJTI(token) != "token-1" {
		t.Fatalf("jwtJTI = %q", jwtJTI(token))
	}
	if jwtUse(token) != "resource" {
		t.Fatalf("jwtUse = %q", jwtUse(token))
	}
	for _, bad := range []string{"", "one.two", "a." + "!!!not-base64!!!" + ".c", "a." + base64.RawURLEncoding.EncodeToString([]byte("not json")) + ".c"} {
		if jwtJTI(bad) != "" || jwtUse(bad) != "" {
			t.Fatalf("malformed token %q must yield empty claims", bad)
		}
	}
}
