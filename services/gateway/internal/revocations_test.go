// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the gateway's revocation cache and sid extraction.

package internal

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

func TestRevocationStoreMarkAndExpire(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	if store.IsRevoked("sid1") {
		t.Fatalf("fresh store should not report sid1 revoked")
	}
	store.markSession("sid1")
	if !store.IsRevoked("sid1") {
		t.Fatalf("sid1 should be revoked after mark")
	}
	store.mu.Lock()
	store.sessions["sid1"] = time.Now().Add(-time.Second)
	store.mu.Unlock()
	if store.IsRevoked("sid1") {
		t.Fatalf("expired entry should not report revoked")
	}
	store.prune()
	store.mu.RLock()
	_, present := store.sessions["sid1"]
	store.mu.RUnlock()
	if present {
		t.Fatalf("prune should drop expired entries")
	}
}

func TestRevocationStoreEmptySessionNotRevoked(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	if store.IsRevoked("") {
		t.Fatalf("empty session id must report not revoked")
	}
}

func TestProcessRevocationMessageRequiresValidSignature(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	redis := &fakeRevocationRedis{verify: false}

	processRevocationMessage(context.Background(), redis, store, redisMessage("1-0", map[string]any{"session_id": "sid1"}), zerolog.New(io.Discard))

	if store.IsRevoked("sid1") {
		t.Fatalf("invalid stream signature must not mark session revoked")
	}
	if len(redis.acked) != 1 || redis.acked[0] != "1-0" {
		t.Fatalf("invalid stream message should be acked once, got %v", redis.acked)
	}
}

func TestProcessRevocationMessageMarksSignedSession(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	redis := &fakeRevocationRedis{verify: true}

	processRevocationMessage(context.Background(), redis, store, redisMessage("1-1", map[string]any{"session_id": "sid1"}), zerolog.New(io.Discard))

	if !store.IsRevoked("sid1") {
		t.Fatalf("valid revocation message should mark session revoked")
	}
	if len(redis.acked) != 1 || redis.acked[0] != "1-1" {
		t.Fatalf("valid stream message should be acked once, got %v", redis.acked)
	}
}

func TestProcessRevocationMessageMarksSignedAgent(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	redis := &fakeRevocationRedis{verify: true}

	processRevocationMessage(context.Background(), redis, store, redisMessage("1-3", map[string]any{"agent_session_id": "agent1"}), zerolog.New(io.Discard))

	if !store.IsAgentRevoked("agent1") {
		t.Fatalf("valid revocation message should mark agent revoked")
	}
	if len(redis.acked) != 1 || redis.acked[0] != "1-3" {
		t.Fatalf("valid stream message should be acked once, got %v", redis.acked)
	}
}

func TestProcessRevocationMessageMarksSignedDelegation(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	redis := &fakeRevocationRedis{verify: true}

	processRevocationMessage(context.Background(), redis, store, redisMessage("1-4", map[string]any{"delegation_edge_id": "edge1"}), zerolog.New(io.Discard))

	if !store.IsDelegationRevoked("edge1") {
		t.Fatalf("valid revocation message should mark delegation edge revoked")
	}
	if len(redis.acked) != 1 || redis.acked[0] != "1-4" {
		t.Fatalf("valid stream message should be acked once, got %v", redis.acked)
	}
}

func TestApplyRevocationSnapshotMarksAllAuthorityAnchors(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	applyRevocationSnapshot(store, []string{"sid1"}, []string{"agent1"}, []string{"edge1"})
	if !store.IsRevoked("sid1") {
		t.Fatalf("snapshot should mark session revoked")
	}
	if !store.IsAgentRevoked("agent1") {
		t.Fatalf("snapshot should mark agent session revoked")
	}
	if !store.IsDelegationRevoked("edge1") {
		t.Fatalf("snapshot should mark delegation revoked")
	}
}

func TestRevocationSnapshotFreshness(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	now := time.Now()
	if store.SnapshotFresh(now) {
		t.Fatal("snapshot must not be fresh before first successful reload")
	}
	store.markSnapshotFresh(now.Add(-snapshotStaleAfter + time.Second))
	if !store.SnapshotFresh(now) {
		t.Fatal("snapshot inside freshness window must be fresh")
	}
	store.markSnapshotFresh(now.Add(-snapshotStaleAfter - time.Second))
	if store.SnapshotFresh(now) {
		t.Fatal("snapshot outside freshness window must be stale")
	}
}

func TestProcessRevocationMessageDeadLettersPoisonMessage(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	redis := &fakeRevocationRedis{verify: true}
	msg := redisMessage("1-2", map[string]any{"zone_id": "zone1"})

	for i := 0; i < maxFailures; i++ {
		processRevocationMessage(context.Background(), redis, store, msg, zerolog.New(io.Discard))
	}

	if len(redis.dead) != 1 {
		t.Fatalf("poison message should be dead-lettered once, got %d", len(redis.dead))
	}
	if len(redis.acked) != 1 || redis.acked[0] != "1-2" {
		t.Fatalf("dead-lettered message should be acked once, got %v", redis.acked)
	}
	if len(redis.deleted) != 1 {
		t.Fatalf("failure counter should be deleted after dead-letter, got %v", redis.deleted)
	}
}

func TestJWTSIDReadsSidClaim(t *testing.T) {
	payload := `{"sid":"sess-123","agent_session_id":"agent-xyz"}`
	tok := "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
	if got := jwtSID(tok); got != "sess-123" {
		t.Fatalf("want sess-123, got %q", got)
	}
}

func TestJWTSIDRequiresSidClaim(t *testing.T) {
	payload := `{"agent_session_id":"agent-xyz"}`
	tok := "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
	if got := jwtSID(tok); got != "" {
		t.Fatalf("want empty sid, got %q", got)
	}
}

func TestJWTAgentSessionIDReadsClaim(t *testing.T) {
	payload := `{"sid":"sess-123","agent_session_id":"agent-xyz"}`
	tok := "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
	if got := jwtAgentSessionID(tok); got != "agent-xyz" {
		t.Fatalf("want agent-xyz, got %q", got)
	}
}

func TestJWTDelegationEdgeIDReadsClaim(t *testing.T) {
	payload := `{"sid":"sess-123","agent_session_id":"agent-xyz","delegation_edge_id":"edge-123"}`
	tok := "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
	if got := jwtDelegationEdgeID(tok); got != "edge-123" {
		t.Fatalf("want edge-123, got %q", got)
	}
}

func TestJWTRootSIDReadsClaim(t *testing.T) {
	payload := `{"sid":"sess-123","root_sid":"root-123"}`
	tok := "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
	if got := jwtRootSID(tok); got != "root-123" {
		t.Fatalf("want root-123, got %q", got)
	}
}

func TestJWTSIDMalformed(t *testing.T) {
	if got := jwtSID("notajwt"); got != "" {
		t.Fatalf("malformed token should return empty sid, got %q", got)
	}
}

func redisMessage(id string, values map[string]any) redis.XMessage {
	return redis.XMessage{ID: id, Values: values}
}

type fakeRevocationRedis struct {
	verify   bool
	acked    []string
	failures int64
	dead     []map[string]any
	deleted  []string
}

func (f *fakeRevocationRedis) EnsureGroup(_ context.Context, _, _ string) error {
	return nil
}

func (f *fakeRevocationRedis) XReadGroup(_ context.Context, _, _, _ string, _ int64) ([]redis.XMessage, error) {
	return nil, nil
}

func (f *fakeRevocationRedis) XAutoClaim(_ context.Context, _, _, _, _ string, _ time.Duration, _ int64) ([]redis.XMessage, string, error) {
	return nil, "0-0", nil
}

func (f *fakeRevocationRedis) XAck(_ context.Context, _, _ string, id string) error {
	f.acked = append(f.acked, id)
	return nil
}

func (f *fakeRevocationRedis) VerifyStream(_ string, _ map[string]any) bool {
	return f.verify
}

func (f *fakeRevocationRedis) SignedXAdd(_ context.Context, _ string, values map[string]any) error {
	f.dead = append(f.dead, values)
	return nil
}

func (f *fakeRevocationRedis) IncrWithExpiry(_ context.Context, _ string, _ time.Duration) (int64, error) {
	f.failures++
	return f.failures, nil
}

func (f *fakeRevocationRedis) Del(_ context.Context, key string) error {
	f.deleted = append(f.deleted, key)
	return nil
}

type ensureGroupFailRedis struct {
	fakeRevocationRedis
	err error
}

func (e *ensureGroupFailRedis) EnsureGroup(_ context.Context, _, _ string) error {
	return e.err
}

func TestStartRevocationConsumerNilRedisFailsStartup(t *testing.T) {
	if err := startRevocationConsumer(context.Background(), nil, newRevocationStore(zerolog.Nop()), zerolog.Nop()); err == nil {
		t.Fatalf("expected nil redis to fail startup")
	}
}

func TestStartRevocationConsumerEnsureGroupFailureSurfaces(t *testing.T) {
	want := errors.New("ensure boom")
	r := &ensureGroupFailRedis{err: want}
	err := startRevocationConsumer(context.Background(), r, newRevocationStore(zerolog.Nop()), zerolog.Nop())
	if err == nil {
		t.Fatal("expected error from EnsureGroup failure, got nil")
	}
	if !errors.Is(err, want) {
		t.Fatalf("expected wrapped %v, got %v", want, err)
	}
}
